---
title: "Manage commands"
description: "config, update, prune, and audit: the admin verbs that keep a trailhead install and its maps healthy."
---

The manage verbs keep an install healthy. They resolve no ticket and set up no isolation workspace. Back to the [command index](/docs/commands).

### /trailhead:config

Guided menu setup, or get and set trailhead config.

**Syntax**

```
/trailhead:config [get | set <key> <value> [--global]]
```

**Arguments**

- none: runs the guided, menu-driven setup.
- `get`: prints the effective merged config, read-only: project `.trailhead/config.json` over global `~/.claude/trailhead/config.json` over the built-in defaults, showing which source wins each key.
- `set <key> <value>`: writes one key directly, to the project file, or to the global file with `--global`.

**What it does**

1. Walks every step in order, as an icon-labelled menu with the current value pre-selected. No step is skipped, and no default is taken silently.
2. The steps are: scope (this project or global); way of working (`git`, `release`, `isolation`); ticket language; models (a profile, or Manual); design (mode; the Stitch surface or the Artifacts design system; mockup approval, see [Design mockups](/docs/design)); TDD; effort; acceptance testing; plan review (the menu is built from the external AI CLIs actually found on your PATH, never including the host's own); and the statusline offer.
3. In the Models step you pick a profile (High, Balanced, Low) that seeds all the model keys at once, or Manual to choose each one (plan and execute are always asked separately). See [Configuration](/docs/configuration#models).
4. Writes the answers and shows a summary. On Codex, after you set `models.codex.*`, you are told to re-run the installer so the pins are re-projected.

**What it writes**

- `.trailhead/config.json` (project scope) or `~/.claude/trailhead/config.json` (global scope).
- The way-of-working keys (`git`, `release`, `isolation`) go into the repo's `trailhead:conventions` issue header instead, because they are shared repo conventions. If that issue does not exist yet, it offers to create a minimal one.
- If you enable the statusline: the script copied to `~/.claude/statusline-trailhead.sh` and the `statusLine` entry in `~/.claude/settings.json` (a global setting). An existing statusline is never replaced silently.

**Example**

```
/trailhead:config set tdd seams
```

trailhead writes `tdd: seams` to the project config and confirms. `/trailhead:config get` then shows it as coming from the project layer.

### /trailhead:update

Check for a newer trailhead and install it.

**Syntax**

```
/trailhead:update
```

**Arguments**

None.

**What it does**

1. Reads the update-check cache (`update-check.json` under your cache dir), refreshing it first if it is missing or a few hours old. If it cannot be read (for example offline), it says so and stops rather than guessing a version.
2. If you are already on the latest, it says so and stops.
3. Otherwise it shows `installed -> latest` and asks for your go-ahead, then acts per install channel:
   - `dev` (a symlinked checkout): `git pull --ff-only` in place. If that is not a fast-forward it stops and leaves it to you.
   - `npm`: re-runs the installer, `npx -y @marcomigozzi/trailhead@latest`.
   - `plugin`: tells you to run `/plugin update trailhead` yourself (and `/plugin marketplace update trailhead` first if the marketplace is stale), since a session cannot run that for you.
4. After a `dev` or `npm` update it refreshes the cache so the statusline's update flag clears, and tells you to restart or reload the agent.
5. Runs a light integrity check (version settled, and the engine surface present: agents, commands and hooks on Claude; the projected skill, agent registry and `multi_agent_v2` on Codex) and offers to re-run the installer if something is missing. It never fixes silently.

**What it writes**

- The update-check cache, and the installed files through the channel's own mechanism. It never edits version files; it consumes releases, it does not cut them.

**Example**

```
/trailhead:update
```

trailhead reports `0.11.1 -> 0.12.0`, asks to proceed, installs, and finishes with `now on 0.12.0` plus the integrity result.

### /trailhead:prune

Reclaim a map's sub-issue slots under GitHub's 100-cap, keeping every reference.

**Syntax**

```
/trailhead:prune [map]
```

**Arguments**

- `map` (optional): a map number or URL. Without it, the active map; with none active and several open, trailhead asks.

**What it does**

1. Reads the map's native sub-issue count and lists every native sub-issue edge, paginated.
2. Classifies each edge: a closed ticket's edge is removed; an open ticket that still carries this map's `trailhead:map-<n>` label keeps its edge; an open ticket that no longer carries the label (an orphan) has its edge removed, after confirming the label is truly absent. It also finds open labelled tickets that have no edge.
3. Shows a preview (edges to remove, the resulting total, and how many missing edges would fit) and waits for an explicit yes. Anything else changes nothing.
4. Removes the edges, re-reads the total, and re-adds missing edges up to the remaining capacity. A single failed edge is recorded and skipped, never fatal.
5. Reports slots reclaimed, edges re-added, and the new total against 100, listing any tickets still lacking an edge.

**What it writes**

- Only the map's native sub-issue edges. The frontier is computed from labels, not edges, so engine behaviour is unchanged; the `Parent:` line, the Decisions so far pointer and the map label all stay. No ticket body, label or state is touched.
- The local `.trailhead/active-map` marker. The dashboard flags a map `near cap · <total>/100` or `at cap` and offers this command; it never prunes on its own.

**Example**

```
/trailhead:prune
```

trailhead previews removing 34 closed edges (total 96 to 62) and re-adding 2 missing ones, and applies it on your yes.

### /trailhead:audit

Hunt regressions in closed work, and find duplicate or groupable open tickets.

**Syntax**

```
/trailhead:audit [map] [--all]
```

**Arguments**

- `map` (optional): a map number or URL, limiting the audit to that map's tickets. Without it, the audit covers every open map plus the whiteboard (closed tickets repo-wide, under any map).
- `--all` (optional): widens the window to every closed ticket instead of only those closed since the last audit. It combines with a map. On a first run with no marker, the whole closed history is covered anyway.

**What it does**

1. Skips tickets that delivered nothing by design (superseded, out-of-scope, closed as duplicate) and checks the rest by type:
   - `build` and `bug`: a fast, deterministic, agent-free check against the commits that carry `Refs: #<n>`. If the code those commits wrote is untouched since, the ticket is classed **unchanged**.
   - `decision`, `research`, `task`, `prototype`: a light inline check that the recorded answer or outcome exists.
   - Where the code changed, or there are no `Refs:` commits to compare, a verification agent re-checks the ticket goal-backward against current code. If more than 20 tickets would need an agent, it shows the count and asks whether to proceed, narrow to one map, or cancel.
2. Classes each ticket: implemented, unchanged, **evolved** (a later ticket changed the code on purpose, named in the report), implemented wrong, not implemented, or unverifiable.
3. Compares the open tickets for duplicates and groupable clusters (same scope, same type, within one map). Claimed tickets are reported as related only.
4. Presents one consolidated report. Nothing has been written to GitHub up to this point.
5. Offers each follow-up as a separate proposal, applied only on an explicit yes: a new `bug` with `Regression of:` for implemented wrong; reopening with a gap comment for not implemented; closing a duplicate natively as a duplicate after carrying its wiring over; or a supersede-and-merge for a groupable cluster. Evolved tickets get no proposal. The last proposal is advancing the audit marker.

**What it writes**

- Nothing until you confirm a proposal. Then: new `bug` tickets, reopened tickets with a comment, duplicate closes, merged tickets with `Merged from:` provenance, as you approved them.
- The last-audit marker, a hidden `<!-- trailhead:last-audit <ISO-8601 UTC> -->` line in the pinned dashboard body, advanced only on an explicit yes and only for a run that covered every map plus the whiteboard. If a ticket was unverifiable, the marker is set just before its close time so the next run picks it up again.

**Example**

```
/trailhead:audit 3
```

trailhead audits map #3 only, reports for example 14 implemented (11 unchanged), 1 evolved by #52 and 1 implemented wrong, then proposes a new regression `bug` for the wrong one and waits for your yes.

Next: [Captures & the whiteboard](/docs/captures) for the commitment spectrum, or back to the [command index](/docs/commands), or on to [Configuration](/docs/configuration) for the keys `config` sets.
