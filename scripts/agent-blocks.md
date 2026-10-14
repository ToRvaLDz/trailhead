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

**Boundaries.** Never `git push`. Never `git stash`, `git reset --hard`, `git checkout -- <path>`, `git restore` on a file you did not change, `git clean -f`, or a branch switch (`git switch`, `git checkout <branch>`). Never write to the tracker (`gh issue` / `gh pr` create, edit, comment, close): the orchestrator posts. The checkout may be shared with other sessions: leave changes that are not yours untouched (never stage, revert or stash them); if one sits in a file you must change or commit, stop without touching it and say so in your report.
<!-- /trailhead:agent-block common -->

<!-- trailhead:agent-block reviewing -->
**Return contract.** Return the complete report as your final message. Do not post it anywhere (no issue comment, no PR comment): the orchestrator posts the `VERIFY` comment after it checks the status line.
- The first line of the report is the technique's `status:` line, verbatim: `status: <token>`, with nothing before it and no other `status:` line.
- trailhead-verify: `<token>` is one of `met` | `gaps_found` | `inconclusive`.
- trailhead-code-review: `<token>` is one of `clean` | `issues_found`, and line 2 is the counts line `critical: <n> · warning: <n> · info: <n>`.
- Read-only: never Edit/Write, never commit.
<!-- /trailhead:agent-block reviewing -->

<!-- trailhead:agent-block implementing -->
**Baseline.** At the start, before any change, record the base SHA: the one the orchestrator names, else `git -C <repo> rev-parse HEAD`. To check whether a failure already exists there, never stash or reset: `tmp=$(mktemp -d)`, `git -C <repo> worktree add --detach "$tmp" <base-sha>`, run the check in `$tmp`, then `git -C <repo> worktree remove --force "$tmp"`. Remove every temporary worktree you created before returning.

**Commits.** Commit only your own changes: stage explicit paths (`git add <path>`), never `git add -A`, `git add .` or `git commit -a`. Each commit is atomic and conventional and ends with the ticket's `Refs: #<n>` trailer.
<!-- /trailhead:agent-block implementing -->
