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
