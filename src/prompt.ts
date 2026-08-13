export interface PromptArgs {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  baseBranch: string;
  headBranch: string;
  extraInstructions?: string;
  rulesFromFile?: string;
}

export function buildReviewPrompt(args: PromptArgs): string {
  const {
    repoFullName, prNumber, prTitle, prBody, baseBranch, headBranch,
    extraInstructions, rulesFromFile,
  } = args;

  return `You are an expert code reviewer. Review Pull Request #${prNumber} in repository ${repoFullName}.

# Pull Request Metadata
- Repository: ${repoFullName}
- PR Number: #${prNumber}
- PR Title: ${prTitle}
- Target Branch: ${baseBranch} ← Feature Branch: ${headBranch}

# Description
${prBody || '(no description)'}

${rulesFromFile ? `
# Project-specific rules (loaded from repo)
${rulesFromFile}
` : ''}${extraInstructions ? `
# Additional instructions
${extraInstructions}
` : ''}

# Task
Please inspect the Pull Request diff for PR #${prNumber} directly. If you use git commands to view the diff, you MUST use the three-dot syntax (e.g., \`git diff origin/${baseBranch}...origin/${headBranch}\`) or rely on the GitHub PR files API. Do NOT use a two-dot diff or compare branch tips directly, as this will incorrectly make you think the PR is deleting recent changes from the base branch.
- Correctness, Security, Reliability, Maintainability, and Tests.

# Output format (STRICT)
Respond in Markdown:

## Summary
One short paragraph stating what the PR does and your overall take.

## Strengths
1-3 bullets on what's well done.

## Findings
Group by severity heading (### [BLOCKING], ### [WARN], ### [NIT]).
CRITICAL: Every finding MUST start with a bullet point specifying the exact file path and line number using the format:
- **\`path/to/file.ext\`, line N**: [SEVERITY] issue description, why it matters, and recommended fix.
CRITICAL: Ensure the line number exactly matches the line in the feature branch (right side of the diff). Do not guess line numbers. Look at the hunk header \`@@\` and carefully count down.

## Verdict
End with EXACTLY one line:
\`VERDICT: approve\` — no blocking issues.
\`VERDICT: comment\` — has warnings/nits but nothing blocking.
\`VERDICT: block\` — one or more BLOCKING issues.

CRITICAL: Do NOT output any conversational text, thinking process, or extra notes before or after the requested markdown format. Output strictly the requested headings and content.
`;
}
