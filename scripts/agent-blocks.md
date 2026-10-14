# Agent blocks

Single source for the text shared by the `plugins/trailhead/agents/trailhead-*.md`
agents. `scripts/sync-agent-blocks.js` copies each block into the agents between
the same marker pair; edit the text here, then run `node scripts/sync-agent-blocks.js`
(`--check` fails when an agent drifted, and `npm test` runs that check).

This file lives in `scripts/`, not `agents/`: Claude Code loads every `.md` under
`agents/` as an agent, and `scripts/` is not shipped.

Every agent gets the `common` block, then the block of its family (see `FAMILIES`
in the script). A family with no block here gets `common` only.

<!-- trailhead:agent-block common -->
**Search-command hygiene.** Prefer the Grep and Read tools; use absolute paths and `git -C <abs>`.
Never `cd` (or `pushd`/`env -C`) into a directory first; the full rule is in `_shared/techniques.md`.
<!-- /trailhead:agent-block common -->

<!-- trailhead:agent-block reviewing -->
**Return contract.** Return the complete report as your final message. Do not post it anywhere (no issue comment, no PR comment): the orchestrator posts the `VERIFY` comment after it checks the status line.
- The first line of the report is the technique's `status:` line, verbatim: `status: <token>`, with nothing before it and no other `status:` line.
- trailhead-verify: `<token>` is one of `met` | `gaps_found` | `inconclusive`.
- trailhead-code-review: `<token>` is one of `clean` | `issues_found`, and line 2 is the counts line `critical: <n> · warning: <n> · info: <n>`.
- Read-only: never Edit/Write, never commit.
<!-- /trailhead:agent-block reviewing -->
