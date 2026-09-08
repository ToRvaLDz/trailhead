---
name: trailhead-manage
user-invocable: false
description: "trailhead manage cluster: the admin verbs that keep a trailhead install healthy. Show the effective config or change it through a guided menu (config); check for a newer trailhead and install it where that is safe (update), and prune a map's sub-issue edges to reclaim slots under GitHub's 100-cap (prune). A cohesion cluster of the trailhead skill split, loading the shared `_shared/` core; reached through the `/trailhead:<verb>` command wrappers and the bare `/trailhead` dispatcher. Not auto-invoked: it runs only when one of these verbs is dispatched."
argument-hint: "[config|update|prune] [get|set … | map]"
---

`trailhead-manage` is the **manage cluster** of the trailhead skill: the admin verbs that keep a trailhead install healthy. `config` shows the effective config or changes it (a guided menu, or `get` / `set <key> <value>`); `update` checks for a newer trailhead and installs it where that is safe; `prune` reclaims a map's native sub-issue slots under GitHub's 100-cap. Everything lives on the GitHub Issues; the repo holds code only.

## Load first, in order

Before doing anything, read `../_shared/load-first.md` and follow it: the shared-core load contract (the six core files, in order, then the effective config). `_shared/` is a **sibling** of this cluster's own directory (at `../_shared/`), never a child of it; its absence from a listing of the cluster dir is expected, not a missing core.

These admin verbs resolve no ticket and set up no isolation workspace.

## Routing: verb to engine

The **first word** of the arguments is the verb (`config`, `update`, or `prune`); the rest is that verb's argument (`get`, `set <key> <value>`, a map, or empty).

- **`config [get|set …]`** to **`../_shared/configuration-reference.md`**: the config keys, their semantics, and the guided menu setup. With no argument it runs the guided setup; `config get` prints the merged config read-only (project `.trailhead/config.json` over global over defaults, showing which source wins each key); `config set <key> <value>` writes one key directly (to the project `.trailhead/config.json`, or to `~/.claude/trailhead/config.json` with `--global`). Read that file and follow it.
- **`update`** to **`references/updating.md`**: the update protocol (detect the install channel, compare the installed version with the latest from the matching source, install the newer one where it is safe). Read that file and follow it.
- **`prune [map]`** to **`references/pruning.md`**: reclaim native sub-issue slots on a map near or at GitHub's 100 sub-issue cap by dropping the edges of closed and orphan tickets and re-adding missing ones, keeping every reference (Parent line, Decisions-so-far pointer, map label). With no argument it prunes the active map. Read that file and follow it.

The full config **key reference** is a single source, shared with the rest of the skill: `../_shared/configuration-reference.md` (keys + guided setup).
