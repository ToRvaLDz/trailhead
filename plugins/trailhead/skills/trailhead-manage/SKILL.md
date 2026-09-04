---
name: trailhead-manage
user-invocable: false
description: "trailhead manage cluster: the admin verbs that keep a trailhead install healthy. Show the effective config or change it through a guided menu (config); check for a newer trailhead and install it where that is safe (update). A cohesion cluster of the trailhead skill split, loading the shared `_shared/` core; reached through the `/trailhead:<verb>` command wrappers and the bare `/trailhead` dispatcher. Not auto-invoked: it runs only when one of these verbs is dispatched."
argument-hint: "[config|update] [get|set …]"
---

`trailhead-manage` is the **manage cluster** of the trailhead skill: the admin verbs that keep a trailhead install healthy. `config` shows the effective config or changes it (a guided menu, or `get` / `set <key> <value>`); `update` checks for a newer trailhead and installs it where that is safe. Everything lives on the GitHub Issues; the repo holds code only.

## Load first, in order

Before doing anything, read the shared core (paths relative to this file):

`_shared/` is a **sibling** of this cluster's own directory (reached at `../_shared/`), never a child of it: the cluster dir holds only this cluster's own files (its `SKILL.md`, and a `references/` dir if it has one), so `_shared/` does not show up in a listing of it, and that absence never means the core is missing. Resolve and read `../_shared/`; never treat "no `_shared/` inside my own cluster dir" as "no shared core installed" and skip the core.

1. `../_shared/principles.md`: refer by name, result-oriented output, no em-dashes, git per conventions, one ticket per session.
2. `../_shared/ticket-language.md`: write all Issue prose and commit bodies in `config.ticket.language` (default `en`), independent of the chat language.
3. `../_shared/substrate.md`: the GitHub-Issues model: labels, the frontier query, the map / ticket / dashboard / whiteboard anatomy, and the base-command cookbook pointer.
4. `../_shared/session-handoff.md`: how every resolution closes (`/clear` first, then the next command).
5. `../_shared/configuration.md`: the three config layers and the load contract.
6. `../_shared/techniques.md`: the technique index and the subagent-type rule.

Load the **effective config** (per `../_shared/configuration.md`) at session start, from the map's project root (`.trailhead/config.json` plus the global file). These admin verbs resolve no ticket and set up no isolation workspace.

## Routing: verb to engine

The **first word** of the arguments is the verb (`config` or `update`); the rest is that verb's argument (`get`, `set <key> <value>`, or empty).

- **`config [get|set …]`** to **`../_shared/configuration-reference.md`**: the config keys, their semantics, and the guided menu setup. With no argument it runs the guided setup; `config get` prints the merged config read-only (project `.trailhead/config.json` over global over defaults, showing which source wins each key); `config set <key> <value>` writes one key directly (to the project `.trailhead/config.json`, or to `~/.claude/trailhead/config.json` with `--global`). Read that file and follow it.
- **`update`** to **`references/updating.md`**: the update protocol (detect the install channel, compare the installed version with the latest from the matching source, install the newer one where it is safe). Read that file and follow it.

The full config **key reference** is a single source, shared with the rest of the skill: `../_shared/configuration-reference.md` (keys + guided setup).
