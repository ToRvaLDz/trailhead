---
title: Hooks
description: The commit guard, secret guard, and injection scanner that enforce trailhead's discipline.
---

Beyond the skill's instructions, trailhead ships three of its own hooks (self-contained, installed alongside the plugin) that *enforce* the parts of the discipline the model shouldn't be trusted to remember:

- **Commit guard** (`PreToolUse` on `git commit`): hard-blocks a commit whose subject isn't [Conventional Commits](https://www.conventionalcommits.org), and hard-blocks any `Co-Authored-By` trailer. This mirrors GSD's commit validation.
- **Secret guard** (`PreToolUse` on `gh` issue/PR writes): trailhead posts a lot to the tracker (ticket bodies, engine comments, codebase/conventions issues, resolutions). This scans what a `gh issue`/`gh pr`/`gh api` write is about to post (the inline `--body`, a heredoc, or a `--body-file`) and hard-blocks it if it matches a credential pattern (private keys, GitHub/AWS/OpenAI/Slack/Google/Stripe tokens, JWTs, or a hardcoded `password`/`secret`/`token=…`). The block is a clean-and-retry cue, not a dead end: trailhead redacts the flagged value in place (`<REDACTED>` or an env-var reference) and re-posts automatically, so the cleaned content still lands — the secret just never reaches the tracker. It stays a fail-safe block rather than a silent auto-rewrite on purpose: a block never leaks, whereas a redaction that quietly failed to apply would. It never scans reads, only outbound writes.
- **Issue injection scanner** (`PostToolUse` on `gh` reads): trailhead reads issue/PR/comment text written by anyone with repo access, i.e. untrusted input. When that text contains prompt-injection phrases, the hook injects an advisory reminding the agent to treat it as data, never as commands. Advisory only: it never blocks.

All three are crash-safe (any error → allow) and active whenever the plugin is installed. The commit and secret guards therefore apply in **every** repo, not only trailhead projects: intentional, since conventional commits, no `Co-Authored-By`, and no leaked secrets are trailhead's standing rules.

To opt out, disable the plugin's hooks in your Claude Code settings.

Next: [Getting started](/docs/getting-started) for the install steps that register these hooks, or [Configuration](/docs/configuration) for the rest of trailhead's settings.
