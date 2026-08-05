import * as core from '@actions/core';
import * as github from '@actions/github';
import { jules } from '@google/jules-sdk';
import { buildReviewPrompt } from './prompt.js';

type FailOn = 'never' | 'blocking' | 'any';
type Verdict = 'approve' | 'comment' | 'block';

interface InlineComment {
  path: string;
  line: number;
  body: string;
}

const COMMENT_MARKER = '<!-- jules-pr-reviewer -->';
const VALID_FAIL_ON: FailOn[] = ['never', 'blocking', 'any'];

async function run(): Promise<void> {
  const apiKey = core.getInput('jules_api_key', { required: true });
  core.setSecret(apiKey);

  const token = core.getInput('github_token', { required: true });
  core.setSecret(token);
  const failOnRaw = core.getInput('fail_on');
  if (!VALID_FAIL_ON.includes(failOnRaw as FailOn)) {
    core.setFailed(`Invalid fail_on: "${failOnRaw}". Must be one of: ${VALID_FAIL_ON.join(', ')}.`);
    return;
  }
  const failOn = failOnRaw as FailOn;
  const skipDrafts = core.getBooleanInput('skip_drafts');
  const skipForks = core.getBooleanInput('skip_forks');
  const bypassLabel = core.getInput('bypass_label');
  const statusContext = core.getInput('status_context');
  const extraInstructions = core.getInput('extra_instructions');
  const rulesFilePath = core.getInput('rules_file');
  const timeoutMinutesRaw = core.getInput('timeout_minutes') || '60';
  const timeoutMinutes = Math.max(1, parseInt(timeoutMinutesRaw, 10) || 60);

  const ctx = github.context;
  if (ctx.eventName === 'pull_request_target') {
    core.setFailed(
      'pull_request_target is not supported — it runs with base-repo write tokens and exposes the action to prompt-injection via attacker-controlled diffs. Use on: pull_request instead.',
    );
    return;
  }
  if (ctx.eventName !== 'pull_request') {
    core.setFailed(`Unsupported event: ${ctx.eventName}. Use on: pull_request.`);
    return;
  }

  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.setFailed('No pull_request payload found.');
    return;
  }

  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const prNumber = pr.number;
  const headSha: string = pr.head.sha;
  const baseSha: string = pr.base.sha;
  const isDraft: boolean = !!pr.draft;
  const isFork: boolean = pr.head.repo?.full_name !== `${owner}/${repo}`;
  const labels: string[] = (pr.labels || []).map((l: any) => l.name);

  const octokit = github.getOctokit(token);

  if (isDraft && skipDrafts) { core.info('Skipping draft PR.'); return; }
  if (isFork && skipForks) { core.info('Skipping fork PR (skip_forks=true).'); return; }
  if (labels.includes(bypassLabel)) {
    core.info(`Bypass label "${bypassLabel}" present — skipping review.`);
    return;
  }

  let commentId: number | undefined;
  let eyesReactionId: number | undefined;

  try {
    try {
      await octokit.rest.repos.createCommitStatus({
        owner, repo, sha: headSha, state: 'pending', context: statusContext,
        description: 'Jules is reviewing this PR…',
      });
    } catch (err) {
      throw wrapPermissionError(err, 'statuses:write', 'createCommitStatus');
    }

    // React to PR with 'eyes' emoji to indicate review in progress
    eyesReactionId = await addReaction(octokit, owner, repo, prNumber, 'eyes');

    // Search for existing review comment or PR review with session ID if present
    let existingSessionId: string | undefined;
    let lastReviewedSha: string | undefined;
    let isAlreadyCompleted = false;

    try {
      const comments = await octokit.rest.issues.listComments({
        owner, repo, issue_number: prNumber,
      });
      const existingComment = comments.data.find(c => c.body?.includes(COMMENT_MARKER));
      if (existingComment && existingComment.body) {
        commentId = existingComment.id;

        const sessionMatch = existingComment.body.match(/_Session:\s*`([^`]+)`_/);
        if (sessionMatch) existingSessionId = sessionMatch[1];

        const shaMatch = existingComment.body.match(/\(Commit:\s*`([a-f0-9]+)`\)/i);
        if (shaMatch) lastReviewedSha = shaMatch[1];

        if (existingComment.body.includes('## 🤖 Jules Review') ||
            existingComment.body.includes('Review complete!') ||
            existingComment.body.includes('🤖 **Jules Review**')) {
          isAlreadyCompleted = true;
        }
      }

      if (!existingSessionId) {
        const reviews = await octokit.rest.pulls.listReviews({
          owner, repo, pull_number: prNumber,
        });
        const existingReview = [...reviews.data].reverse().find(r => r.body?.includes(COMMENT_MARKER));
        if (existingReview && existingReview.body) {
          const sessionMatch = existingReview.body.match(/_Session:\s*`([^`]+)`_/);
          if (sessionMatch) existingSessionId = sessionMatch[1];

          const shaMatch = existingReview.body.match(/\(Commit:\s*`([a-f0-9]+)`\)/i);
          if (shaMatch) lastReviewedSha = shaMatch[1];

          if (existingReview.body.includes('## 🤖 Jules Review') ||
              existingReview.body.includes('Review complete!') ||
              existingReview.body.includes('🤖 **Jules Review**')) {
            isAlreadyCompleted = true;
          }
        }
      }
    } catch (err) {
      core.warning(`Failed to search existing PR comments/reviews: ${String(err)}`);
    }

    const customJules = jules.with({ apiKey });
    let session: any;
    let expectedMinMessages = 1;
    const shortSha = headSha.slice(0, 7);
    let skipReviewGeneration = false;

    if (existingSessionId) {
      core.info(`Resuming existing Jules session: ${existingSessionId}`);
      session = customJules.session(existingSessionId);

      // Count existing agentMessaged count before sending update
      let existingMsgCount = 0;
      let lastActivityType = '';
      try {
        await session.hydrate();
        for await (const a of session.history()) {
          lastActivityType = a.type;
          if (a.type === 'agentMessaged') existingMsgCount++;
        }
      } catch (e) {
        core.info(`Could not count existing history messages: ${String(e)}`);
      }
      
      if (lastReviewedSha === shortSha) {
        if (isAlreadyCompleted) {
          core.info(`Session already reviewed commit ${shortSha}. Skipping generation.`);
          skipReviewGeneration = true;
        } else {
          core.info(`Resuming session on same commit ${shortSha}.`);
          // If the last activity was userMessaged (the update prompt), it means Jules hasn't replied to it yet.
          if (lastActivityType === 'userMessaged') {
            expectedMinMessages = existingMsgCount + 1;
          } else {
             // If the last activity was from Jules, we should just expect that message (or wait for the first if none exist).
            expectedMinMessages = Math.max(1, existingMsgCount);
          }
        }
      } else {
        expectedMinMessages = existingMsgCount + 1;
        core.info(`Existing agentMessaged count: ${existingMsgCount}. Waiting for message #${expectedMinMessages}.`);
        const updatePrompt = `A new commit has been pushed to PR #${prNumber} on branch \`${pr.head.ref}\` (Commit: \`${shortSha}\`).
Please review the updated commit/changes on branch \`${pr.head.ref}\` and update your review and verdict accordingly. Remember to end your response with:
VERDICT: approve (or comment or block)`;

        core.info('Sending update prompt to existing session...');
        await session.send(updatePrompt);

        // Update placeholder comment for the new commit
        const placeholderBody = `${COMMENT_MARKER}\n⏳ **Jules is reviewing this PR...** (Commit: \`${shortSha}\`)\n\n---\n_Session: \`${session.id}\`_`;
        if (commentId) {
          await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: placeholderBody });
        } else {
          const created = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: placeholderBody });
          commentId = created.data.id;
        }
      }
    } else {
      let rulesFromFile: string | undefined;
      if (rulesFilePath) {
        rulesFromFile = await loadRulesFromBase(octokit, owner, repo, rulesFilePath, baseSha);
      }

      const prompt = buildReviewPrompt({
        repoFullName: `${owner}/${repo}`,
        prNumber,
        prTitle: pr.title || '',
        prBody: pr.body || '',
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        extraInstructions: extraInstructions || undefined,
        rulesFromFile,
      });

      core.info('Creating new Jules review session…');
      session = await customJules.session({
        prompt,
        source: { github: `${owner}/${repo}`, baseBranch: pr.base.ref },
        requireApproval: false,
        autoPr: false,
      });
      core.info(`New Jules session: ${session.id}`);

      // Save a placeholder comment with the session ID immediately so that we can resume it if we timeout.
      const placeholderBody = `${COMMENT_MARKER}\n⏳ **Jules is reviewing this PR...** (Commit: \`${shortSha}\`)\n\n---\n_Session: \`${session.id}\`_`;
      if (commentId) {
        await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: placeholderBody });
      } else {
        const created = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: placeholderBody });
        commentId = created.data.id;
      }

      await waitUntilSessionReady(session);
    }

    let reviewMessage = '';
    if (!skipReviewGeneration) {
      reviewMessage = await pollForReview(session as any, timeoutMinutes * 60 * 1000, expectedMinMessages);
      core.info(`Collected review (${reviewMessage.length} chars)`);
    }

    if (!reviewMessage && !skipReviewGeneration) {
      if (eyesReactionId) await deleteReaction(octokit, owner, repo, prNumber, eyesReactionId);
      await markCommentFailed(
        octokit, owner, repo, prNumber, commentId,
        `Jules did not return a review within ${timeoutMinutes} minutes. Session: \`${session.id}\`. ` +
        `The session may still be running on Jules' side — check https://jules.google.com/session/${session.id}. ` +
        `Consider raising the action's \`timeout_minutes\` input or re-running the workflow.`,
        session, shortSha
      );
      await setStatus(octokit, owner, repo, headSha, statusContext, 'error', 'Jules did not return a review in time');
      core.setFailed(`Jules returned no review message within ${timeoutMinutes} minutes.`);
      return;
    }

    const verdict = parseVerdict(reviewMessage);

    // Only process comments if we actually generated a new review
    if (!skipReviewGeneration) {
      // Parse and post line-level inline comments if present in the review output
      let postedInline = false;
      const inlineComments = parseInlineComments(reviewMessage);
      if (inlineComments.length > 0) {
        core.info(`Found ${inlineComments.length} inline line-level finding(s). Posting to PR...`);
        try {
          await octokit.rest.pulls.createReview({
            owner, repo, pull_number: prNumber,
            commit_id: headSha,
            event: 'COMMENT',
            body: `${COMMENT_MARKER}\n🤖 **Jules Review** (Commit: \`${shortSha}\`)\n\n---\n_Session: \`${session.id}\`_`,
            comments: inlineComments.map(c => ({
              path: c.path,
              line: c.line,
              body: `🤖 **Jules Finding**: ${c.body}`
            }))
          });
          postedInline = true;

          // Update placeholder to indicate completion since inline comments were posted
          if (commentId) {
            const completedBody = `${COMMENT_MARKER}\n✅ **Review complete! See inline comments.** (Commit: \`${shortSha}\`)\n\n---\n_Session: \`${session.id}\`_`;
            await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: completedBody });
          }
        } catch (err) {
          core.warning(`Could not post line-level review comments: ${String(err)}`);
        }
      }

      // Remove the initial 'eyes' reaction
      if (eyesReactionId) {
        await deleteReaction(octokit, owner, repo, prNumber, eyesReactionId);
      }

      if (verdict === 'approve') {
        // Add thumbsup reaction on clean approval
        await addReaction(octokit, owner, repo, prNumber, '+1');
      }

      // Only post top-level comment if NO inline findings were posted
      if (!postedInline) {
        const cleanBody = stripFindingsSection(reviewMessage);
        const finalBody =
          `${COMMENT_MARKER}\n## 🤖 Jules Review (Commit: \`${shortSha}\`)\n\n${cleanBody}\n\n---\n_Session: \`${session.id}\`_`;

        if (commentId) {
          await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: finalBody });
        } else {
          let created = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: finalBody });
          commentId = created.data.id;
        }
      }
    }

    if (!skipReviewGeneration) {
      const { state, description } = statusFromVerdict(verdict, failOn);
      await setStatus(octokit, owner, repo, headSha, statusContext, state, description);

      core.info(`Verdict: ${verdict}. Status check: ${state}.`);
    } else {
      core.info(`Review already fully completed for commit ${shortSha}.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.error(`Review failed: ${msg}`);

    const safeErrorMsg = "An internal error occurred during the review process. Please check the action logs for details.";
    const shortSha = headSha.slice(0, 7);

    if (eyesReactionId) {
      await deleteReaction(octokit, owner, repo, prNumber, eyesReactionId).catch(() => {});
    }
    await markCommentFailed(octokit, owner, repo, prNumber, commentId, safeErrorMsg, undefined, shortSha).catch(() => {});
    await setStatus(octokit, owner, repo, headSha, statusContext, 'error', truncate(safeErrorMsg, 140))
      .catch(() => {});
    core.setFailed(`Jules PR review failed: ${msg}`);
  }
}

function parseInlineComments(reviewMessage: string): InlineComment[] {
  const comments: InlineComment[] = [];
  const regex = /(?:^|\n)(?:-\s*)?(?:\*\*)?`?([a-zA-Z0-9_\-\/.\\]+\.[a-zA-Z0-9]+)`?(?:\*\*)?(?:,\s*lines?\s*|:)\s*(\d+)(?:-\d+)?(?:\*\*)?\s*:\s*(.+)/gi;
  let match;
  while ((match = regex.exec(reviewMessage)) !== null) {
    const filePath = match[1].trim();
    const lineNum = parseInt(match[2], 10);
    const text = match[3].trim();
    if (filePath && !isNaN(lineNum) && text) {
      comments.push({ path: filePath, line: lineNum, body: text });
    }
  }
  return comments;
}

async function fetchDiff(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, pr: any,
): Promise<string> {
  try {
    const res = await octokit.rest.pulls.get({
      owner, repo, pull_number: pr.number, mediaType: { format: 'diff' },
    });
    const data = res.data as unknown;
    if (typeof data === 'string') return data;
  } catch (err) {
    core.warning(`pulls.get diff failed, falling back to compare: ${String(err)}`);
  }
  const compare = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo,
    basehead: `${pr.base.sha}...${pr.head.sha}`,
    mediaType: { format: 'diff' },
  });
  const data = compare.data as unknown;
  if (typeof data !== 'string') {
    throw new Error('GitHub returned no diff text.');
  }
  return data;
}

async function loadRulesFromBase(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, path: string, baseSha: string,
): Promise<string | undefined> {
  try {
    const file = await octokit.rest.repos.getContent({ owner, repo, path, ref: baseSha });
    if ('content' in file.data && typeof file.data.content === 'string') {
      const content = Buffer.from(file.data.content, 'base64').toString('utf8');
      core.info(`Loaded ${content.length} chars from ${path} at base SHA`);
      return content;
    }
    core.warning(`${path} is not a regular file.`);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404') || msg.includes('Not Found')) return undefined;
    core.warning(`Could not load ${path} at base SHA: ${msg}`);
    return undefined;
  }
}

async function setStatus(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, sha: string, context: string,
  state: 'pending' | 'success' | 'failure' | 'error',
  description: string,
): Promise<void> {
  await octokit.rest.repos.createCommitStatus({
    owner, repo, sha, state, context, description,
  });
}

async function addReaction(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, issueNumber: number, content: 'eyes' | '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket'
): Promise<number | undefined> {
  try {
    const res = await octokit.rest.reactions.createForIssue({
      owner, repo, issue_number: issueNumber, content,
    });
    return res.data.id;
  } catch (err) {
    core.warning(`Failed to add '${content}' reaction: ${String(err)}`);
    return undefined;
  }
}

async function deleteReaction(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, issueNumber: number, reactionId: number
): Promise<void> {
  try {
    await octokit.rest.reactions.deleteForIssue({
      owner, repo, issue_number: issueNumber, reaction_id: reactionId,
    });
  } catch (err) {
    core.warning(`Failed to delete reaction ${reactionId}: ${String(err)}`);
  }
}

function stripFindingsSection(message: string): string {
  return message.replace(/##\s*Findings[\s\S]*?(?=\n##\s+|$)/i, '').trim();
}

async function markCommentFailed(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, issueNumber: number, commentId: number | undefined, reason: string,
  session?: { id: string }, shortSha?: string
): Promise<void> {
  let body = `${COMMENT_MARKER}\n⚠️ **Jules PR review failed to complete.**`;
  if (shortSha) {
    body += ` (Commit: \`${shortSha}\`)`;
  }
  body += `\n\n\`\`\`\n${truncate(reason, 500)}\n\`\`\`\n\nSee the [workflow logs](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}) for details.`;

  if (session?.id) {
    body += `\n\n---\n_Session: \`${session.id}\`_`;
  }

  if (commentId) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}

function isAuthError(msg: string): boolean {
  return /\b(?:401|403)\b/.test(msg);
}

function wrapPermissionError(err: unknown, needed: string, op: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (isAuthError(msg) || msg.includes('Resource not accessible')) {
    return new Error(
      `${op} failed with 403. The github_token likely lacks ${needed}. Add to your workflow:\n` +
      `    permissions:\n      pull-requests: write\n      contents: read\n      statuses: write\n` +
      `(original: ${msg})`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function pollForReview(
  session: { id: string; hydrate: () => Promise<number>; history: () => AsyncIterable<any> },
  timeoutMs: number,
  expectedMinMessages: number = 1,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      await session.hydrate();
      let messageCount = 0;
      let lastMessage = '';
      for await (const a of session.history()) {
        if (a.type === 'agentMessaged') {
          messageCount++;
          lastMessage = a.message;
        }
      }
      if (messageCount >= expectedMinMessages) {
        core.info(`Got new agentMessaged (${messageCount}/${expectedMinMessages}) on attempt ${attempt}.`);
        return lastMessage;
      }
      core.info(`Waiting for new agentMessaged (have ${messageCount}, need ${expectedMinMessages}) (attempt ${attempt})…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(msg)) {
        throw new Error(`Jules API rejected request (${msg}). Check JULES_API_KEY is valid.`);
      }
      core.info(`hydrate/history error (attempt ${attempt}): ${msg}`);
    }
    await new Promise(r => setTimeout(r, 10_000));
  }
  return '';
}

async function waitUntilSessionReady(session: { id: string; info: () => Promise<unknown> }): Promise<void> {
  const maxAttempts = 20;
  let delay = 2000;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await session.info();
      core.info(`Session ${session.id} is ready after ${i + 1} attempt(s).`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(msg)) {
        throw new Error(`Jules API rejected request (${msg}). Check JULES_API_KEY is valid.`);
      }
      if (!msg.includes('404')) {
        throw new Error(`Jules session.info() failed: ${msg}`);
      }
      core.info(`Session not yet ready (attempt ${i + 1}/${maxAttempts})…`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 15000);
    }
  }
  throw new Error('Session did not become ready within timeout.');
}

function truncateDiff(diff: string, maxChars: number): { text: string; truncatedNote?: string } {
  if (diff.length <= maxChars) return { text: diff };
  const text = diff.slice(0, maxChars);
  return {
    text,
    truncatedNote: `The diff was truncated: original ${diff.length} chars, kept first ${maxChars}.`,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function parseVerdict(message: string): Verdict {
  const match = message.match(/VERDICT:\s*(approve|comment|block)/i);
  if (match) return match[1].toLowerCase() as Verdict;
  if (/\[BLOCKING\]/.test(message)) return 'block';
  return 'comment';
}

function statusFromVerdict(
  verdict: Verdict,
  failOn: FailOn,
): { state: 'success' | 'failure'; description: string } {
  if (failOn === 'never') {
    return { state: 'success', description: `Review complete (verdict: ${verdict})` };
  }
  if (failOn === 'any') {
    return verdict === 'approve'
      ? { state: 'success', description: 'Approved' }
      : { state: 'failure', description: `Review verdict: ${verdict}` };
  }
  return verdict === 'block'
    ? { state: 'failure', description: 'Blocking issues found' }
    : { state: 'success', description: `Review complete (verdict: ${verdict})` };
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
