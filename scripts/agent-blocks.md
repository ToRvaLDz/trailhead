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

**Boundaries.** Never `git push`. Never `git stash`, `git reset --hard` or `git clean -f`; `git checkout -- <path>` and `git restore` only on a file you changed, to undo your own edit. Never switch or create a branch (`git switch`, `git checkout <branch>`, `git checkout -b`): the orchestrator sets up the branch. Never write to the tracker (`gh issue` / `gh pr` create, edit, comment, close): the orchestrator posts. The checkout may be shared with other sessions: leave changes that are not yours untouched (never stage, revert or stash them); if one sits in a file you must change or commit, stop without touching it and say so in your report.
<!-- /trailhead:agent-block common -->

<!-- trailhead:agent-block reviewing -->
**Return contract.** Return the complete report as your final message. Do not post it anywhere (no issue comment, no PR comment): the orchestrator posts the `VERIFY` comment after it checks the status line.
- The first line of the report is the technique's `status:` line, verbatim: `status: <token>`, with nothing before it and no other `status:` line.
- trailhead-verify: `<token>` is one of `met` | `gaps_found` | `inconclusive`; each claim line carries `class: <met|unmet|partial|inconclusive>`, and `met` lists no `unmet`, `partial` or `inconclusive` claim.
- trailhead-code-review: `<token>` is one of `clean` | `issues_found`, and line 2 is the counts line `critical: <n> · warning: <n> · info: <n>`; `clean` with a non-zero `critical` count requires a ledger line closing every Critical (`fixed`, `deferred` or `accepted`), none `open`.
- Read-only: never Edit/Write, never commit.
<!-- /trailhead:agent-block reviewing -->

<!-- trailhead:agent-block implementing -->
**Baseline.** At the start, before any change, record the base SHA: the one the orchestrator names, else `git -C <repo> rev-parse HEAD`. To check whether a failure already exists there, never stash or reset: `tmp=$(mktemp -d)`, `git -C <repo> worktree add --detach "$tmp" <base-sha>`, run the check in `$tmp`, then `git -C <repo> worktree remove --force "$tmp"`. The temporary worktree has no installed dependencies: if the check fails there only because of a missing install, call the baseline inconclusive in your report, never pre-existing. Remove every temporary worktree you created before returning.

**Commits.** Commit only your own changes: stage explicit paths (`git add <path>`), never `git add -A`, `git add .` or `git commit -a`, and commit them by path (`git commit -- <path>...`) so a change another session already staged is never swept in. Each commit is atomic and conventional and ends with the ticket's `Refs: #<n>` trailer.

**Return contract.** Return the complete report as your final message. Do not post it anywhere (no issue comment, no PR comment): the orchestrator posts what it needs from it.
- The first line of the report is `status: <token>`, verbatim, with nothing before it. It is the only line starting with `status:`: status text anywhere in the body is quoted in a code fence or a blockquote, or reworded.
- statuses: `done` | `partial` | `blocked`.
- required fields: `commits`, `tests`, `deviations`, `blockers`.
- optional fields: `fidelity`, `surfaced scope`.
- invariant: `done` => `blockers` none.
- invariant: `partial`, `blocked` => `blockers` non-empty.
- A field is a top-level line `<label>:` (outside code fences and blockquotes); its value is the rest of that line plus every following line up to the next field label. An empty value or `none` means none.
- Fields are the end of the report: nothing after the last field.
- `commits:` one `<sha> <subject>` per line: every commit carrying the ticket's `Refs: #<n>` since the base SHA, including those of an earlier spawn. The orchestrator checks this list against the repo.
- `tests:` the command you ran and its result.
- `deviations:` where you departed from the PLAN (or the DIAGNOSIS), or `none`.
- `blockers:` `none` when `done`. Otherwise one entry per blocker: each flagged package with its exact install command and the evidence that flagged it, each infeasible mockup element with why, each foreign change in the way.
- `fidelity:` required when a mockup was passed: every element and state of the approved mockup, `element/state -> reproduced | infeasible (why)`.
- `surfaced scope:` new scope you found and did not work, if any.
<!-- /trailhead:agent-block implementing -->

<!-- trailhead:agent-block investigating -->
**Return contract.** Return the complete report as your final message. Do not post it anywhere (no issue comment, no PR comment): the orchestrator posts it. Never commit, and never create or switch a branch: the report is the only artifact.
- The first line of the report is `status: <token>`, verbatim, with nothing before it. It is the only line starting with `status:`: status text anywhere in the body is quoted in a code fence or a blockquote, or reworded.
- statuses: `found` | `inconclusive` | `needs_input`.
- required fields: `answer`, `evidence`, `open questions`.
- optional fields: none.
- invariant: `needs_input` => `open questions` non-empty.
- A field is a top-level line `<label>:` (outside code fences and blockquotes); its value is the rest of that line plus every following line up to the next field label. An empty value or `none` means none.
- Fields are the end of the report: nothing after the last field.
- `answer:` the decision-ready answer to the one question you were given, with your confidence.
- `evidence:` what backs the answer, one item per line: `file:line` for code, the URL for every external claim.
- `open questions:` what you could not settle, or `none`. With `needs_input` it holds the questions only the user can answer.
<!-- /trailhead:agent-block investigating -->

<!-- trailhead:agent-block plan -->
**Return contract.** Return the complete report as your final message. Do not post it anywhere (no issue comment, no PR comment): the orchestrator posts the PLAN. Never commit.
- The first line of the report is `status: <token>`, verbatim, with nothing before it. It is the only line starting with `status:`: status text anywhere in the body is quoted in a code fence or a blockquote, or reworded.
- statuses: `ready` | `needs_input`.
- required fields: none.
- optional fields: `questions`.
- invariant: `ready` => `body` non-empty.
- invariant: `needs_input` => `questions` non-empty.
- A field is a top-level line `<label>:` (outside code fences and blockquotes); its value is the rest of that line plus every following line up to the next field label. An empty value or `none` means none.
- With `needs_input`, fields are the end of the report: nothing after the last field.
- `ready`: the rest of the report is the PLAN (the `body`): the steps, the seams, the files touched and the verification criteria. It is posted verbatim, so write nothing in it that is not the PLAN.
- `needs_input`: `questions:` holds the blocking questions only; no PLAN.
<!-- /trailhead:agent-block plan -->
