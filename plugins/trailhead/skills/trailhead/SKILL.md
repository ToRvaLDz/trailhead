---
name: trailhead
description: "Start and drive a large project (more than one agent session can hold) as a map of decision tickets on GitHub Issues, resolving one at a time until the way to the destination is clear. Self-contained (zero external-plugin dependencies: trailhead ships its own `trailhead-*` engine agents and needs only an authenticated gh CLI): map-based onboarding and a discuss→plan→execute→verify engine with atomic commits, with everything (map, discussion, plan, verification) living on the Issues. Invoke only when the user explicitly runs `/trailhead` (or a `/trailhead:<verb>` command) or asks to chart, adopt, or work a trailhead map, and do not auto-invoke for generic planning, project, or task-tracking requests."
argument-hint: "[new|adopt|work|quick|whiteboard|ticket|inbox|map|dashboard|config|grill|split|pause|resume|auto|update|bug|todo|idea|seed|note] [text | ticket]"
---

`trailhead` charts a large project as a **shared map on GitHub Issues**, then works its **tickets** one at a time until the way to the destination is clear. This skill is the **entry point**: bare `/trailhead` runs **smart entry** (detect the repo state and propose the next move); a verb runs that verb's engine. Everything lives on the Issues; the repo holds code only.

## Load first, in order

Before doing anything, read the shared core (paths relative to this file):

`_shared/` is a **sibling** of this cluster's own directory (at `../_shared/`, i.e. `~/.claude/skills/_shared/`), never a child of it: it does not show up in a listing of this cluster dir (which by design holds only `SKILL.md` and `references/`), and that absence never means the core is missing. Resolve and read `../_shared/`; never treat "no `_shared/` inside my own cluster dir" as "no shared core installed" and skip the core.

1. `../_shared/principles.md`: refer by name, result-oriented output, no em-dashes, git per conventions, one ticket per session.
2. `../_shared/ticket-language.md`: write all Issue prose and commit bodies in `config.ticket.language` (default `en`), independent of the chat language.
3. `../_shared/substrate.md`: the GitHub-Issues model: labels, the frontier query, the map / ticket / dashboard / whiteboard anatomy, and the base-command cookbook pointer.
4. `../_shared/session-handoff.md`: how every resolution closes (`/clear` first, then the next command).
5. `../_shared/configuration.md`: the three config layers and the load contract.
6. `../_shared/techniques.md`: the technique index and the subagent-type rule.

Load the **effective config** (per `../_shared/configuration.md`) at session start, from the map's project root (`.trailhead/config.json` plus the global file), before any isolation workspace is set up.

## Routing: verb to engine

The **first word** of the arguments is the verb; the rest is the text or a ticket number. `/trailhead <verb>` and `/trailhead:<verb>` are equivalent.

- **No verb** to **smart entry** (below): this skill handles it directly.
- **A verb** to hand off to the skill that owns it, passing the whole argument string. **The skill-split migration ([map #53](https://github.com/ToRvaLDz/trailhead/issues/53)) lands the cluster skills one at a time.** The **chart cluster is built (#59)**: `new`, `adopt`, `ticket`, `inbox`, and `grill` route to the **`trailhead-chart`** skill (call the Skill tool with skill name `trailhead-chart` and arguments `<verb> <rest>`). The **work cluster is built (#60)**: `work`, `quick`, `pause`, `resume`, `split`, and `auto` route to the **`trailhead-work`** skill (call the Skill tool with skill name `trailhead-work` and arguments `<verb> <rest>`). The **view cluster is built (#61)**: `map`, `dashboard`, and `whiteboard` route to the **`trailhead-view`** skill (call the Skill tool with skill name `trailhead-view` and arguments `<verb> <rest>`). The **capture cluster is built (#62)**: `bug`, `todo`, `idea`, `seed`, and `note` route to the **`trailhead-capture`** skill (call the Skill tool with skill name `trailhead-capture` and arguments `<verb> <rest>`). The **manage cluster is built (#63)**: `config` and `update` route to the **`trailhead-manage`** skill (call the Skill tool with skill name `trailhead-manage` and arguments `<verb> <rest>`). Then carry out the target skill's instructions.
- **Unrecognised verb** to treat the whole string as `idea` (route to `trailhead-capture` as `idea <text>`).

The namespaced `/trailhead:<verb>` commands reach their target skill directly through their own command wrapper; this routing table only covers the bare `/trailhead <verb>` form.

## Smart entry (bare `/trailhead`)

With no verb, detect the repo state and **propose**, do not dead-end:

- **No map** to offer *chart* (`/trailhead:new`) or *adopt* (`/trailhead:adopt`); or point at `/trailhead:whiteboard` if the repo has loose `trailhead:whiteboard` tickets but no map.
- **Map present with a workable frontier** to route to *work*. Bare `/trailhead:work` takes one ticket to act on, but present the frontier as a **set to choose from** when its tickets are mutually independent, never a crowned first-listed (see **Frontier order carries no priority** in `../_shared/substrate.md`).
- **Map present but its frontier is empty** (everything left is gated or still fog, or the map is complete-except-gated) to lay out the sensible moves as a short list, and **always include `/trailhead:quick "<text>"` right after `/trailhead:map`** as the way to do a discrete piece of work off the map now (`/trailhead:quick <n>` to work a loose ticket), alongside `/trailhead:map` for the full view, `/trailhead:whiteboard` when loose work waits, `/trailhead:new` to chart the next map, the captures (`todo` / `idea` / `bug` / `seed`) for new work, and graduating a fog line into a ticket when it is sharp enough.

**Self-heal the pinned dashboard** before proposing: ensure the repo's `trailhead:dashboard` index exists and is pinned. Ensure the label, then **create + pin only if missing, re-pin if the pin was dropped, and never rewrite the body on this render** (the dashboard model is in `../_shared/substrate.md`; the exact `gh` commands live in the substrate cookbook, at `../_shared/substrate-commands.md`). So a repo that adopted trailhead before the dashboard existed gets one on the next bare `/trailhead`.

**First-time config offer (once per project).** When a project has a map but **no `.trailhead/config.json` yet**, put an **explicit two-way choice** to the user and wait for their pick: **(a) accept as-is** (continue on the current or proposed values, which writes an empty `{}`), or **(b) run `/trailhead:config`** to configure everything through the guided menu (models / design / TDD / ...). **Always name both paths and let the user choose; never silently take one.** You may show the values you would default to, but frame the close as this binary: **do not** pre-fill the config keys and ask for an open-ended inline edit, and **do not** interview the user key-by-key inline (that is `/trailhead:config`'s job). Ask this **only once**: running config writes the file, and *accept as-is* writes an empty `{}`, so once `.trailhead/config.json` exists it is never offered again (a `{}` file means "reviewed, using defaults"). The same offer is made at the end of chart / adopt. It fires on the bare `/trailhead` and when setting a project up, never in the middle of working a ticket.

Every verb is also a **namespaced command** (`/trailhead:new`, `/trailhead:work`, `/trailhead:bug`, ...) so typing `/trailhead` lists them all in the picker; they delegate to their owning skill.
