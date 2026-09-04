---
name: trailhead-chart
user-invocable: false
description: "trailhead chart cluster: the verbs that give a map its start or bring outside work into it. Chart a new map from a loose idea (new), adopt an existing codebase into a map (adopt), open a ticket of any type on the fly (ticket), triage issues opened by others into the map (inbox), and run a standalone grilling session (grill). A cohesion cluster of the trailhead skill split, loading the shared `_shared/` core; reached through the `/trailhead:<verb>` command wrappers and the bare `/trailhead` dispatcher. Not auto-invoked: it runs only when one of these verbs is dispatched."
argument-hint: "[new|adopt|ticket|inbox|grill] [idea | <type> <title> | issue | topic]"
---

`trailhead-chart` is the **chart cluster** of the trailhead skill: the verbs that give a map its start or bring outside work into it. `new` charts a new map from a loose idea; `adopt` maps an existing codebase into a map; `ticket` opens a ticket of any type on the fly; `inbox` triages issues opened by others; `grill` runs a standalone grilling session. Everything lives on the GitHub Issues; the repo holds code only.

## Load first, in order

Before doing anything, read `../_shared/load-first.md` and follow it: the shared-core load contract (the six core files, in order, then the effective config). `_shared/` is a **sibling** of this cluster's own directory (at `../_shared/`), never a child of it; its absence from a listing of the cluster dir is expected, not a missing core.

## Routing: verb to engine

The **first word** of the arguments is the verb; the rest is the text (a loose idea, a `<type> <title>`, an issue number, or a topic).

- **`new`** / **`adopt`** to **`references/charting.md`**: how a map is born (Mode 1 and Mode 1-bis). Read that file.
- **`ticket <type> <title>`** to the **Open a ticket on the fly** engine below.
- **`inbox [issue]`** to **`references/inbox.md`**: the triage protocol. Read that file.
- **`grill [topic|ticket]`** to the **Standalone grill** engine below.

The cross-cluster situational references and the technique bodies these engines call live in `_shared/`; this cluster names each by its `../_shared/...` path where it needs one (the gh cookbook, the out-of-scope rules, teamwork, the techniques).

## Chart a new map / adopt a project: `new`, `adopt`

Read **`references/charting.md`** and follow it. It holds both protocols: **Mode 1** (chart a new map: name the destination, map the frontier breadth-first, harvest parked work from earlier maps, create the map plus the first-use repo setup, the per-map label, conventions, and the dashboard, create-then-wire the tickets, fire the research, offer config) and **Mode 1-bis** (adopt an existing project: map the codebase once into the repo's `trailhead:codebase` issue, backfill the decisions already embodied in the code, detect a monorepo / submodules / path-bound tooling to seed the `isolation:` convention, then map the frontier of the remainder). At the end of chart or adopt, make the **First-time config offer** (below).

## Open a ticket on the fly: `ticket <type> <title>`

Open ticket(s) of the map on the fly, for any of the six types (`decision`, `research`, `prototype`, `build`, `bug`, `task`), the escape hatch the capture verbs do not cover. **Adding a ticket is a micro-charting act, so diverge briefly first, do not blind-commit to a single piece:** run a short breadth-first pass around the request: is this really *one* session-sized ticket, or a small **cluster** (a `decision` that needs a `research` before it, a UI `build` that needs a `prototype`, obvious siblings)? Does it imply a blocker? Surface the neighbours, *then* create the ticket(s): each gets `trailhead:ticket` plus its `trailhead:<type>`, its map's `trailhead:map-<n>` label and native sub-issue edge, a `Parent:` line, and a `## Question`; put each on the frontier, or, for a known-blocked one, create it already carrying `trailhead:blocked` (in its `--label` list) and wire its `## Blocked by` + native dependency (the three-move blocker wiring, with the label riding at creation, and the child-to-map link are in `../_shared/substrate.md`; the exact gh commands are in `../_shared/substrate-commands.md`). This is a framing brainstorm (is this the right work?), distinct from the `decision` engine's option brainstorm (which choice?). If `<type>` is missing or invalid, ask which of the six. *(The zero-friction captures, `bug` / `todo` / `idea` / `seed` / `note`, deliberately skip this diverge-first pass; they are one action, one confirmation, and are served by the capture cluster.)*

## Triage the inbox: `inbox [issue]`

Read **`references/inbox.md`** and follow it. It triages issues opened by others (bug reports, requests, questions that are not trailhead tickets) and integrates the worthwhile ones **in place**: reframing them as tickets, keeping the reporter's authorship, applying the labels on adoption; the rest routes to fog, out-of-scope, duplicate, or needs-info. It also surfaces **parked `trailhead:fog`** whose thread went quiet-then-active (that is how you notice a fog has cleared), **and sweeps the map's own *Out of scope* for lines that are actually deferred** (a gate/trigger or a wanted-later feature), asking the user to re-route each to a seed / idea / todo (which map) and wiring it gate-first with a live trigger. This is the surface where the map's read-only advisory turns into an actual re-route.

## Standalone grill: `grill [topic|ticket]`

Run a standalone **Grilling** (plus **Domain vocabulary**) session on a decision or topic, or on a named ticket, without committing to the full work cycle. Read the two techniques and follow them: `../_shared/techniques/grilling.md` and `../_shared/techniques/domain-vocabulary.md` (these are multi-cluster techniques, so their bodies live in `_shared/`). Record the outcome where it belongs: a ticket's resolution, the map's `Decisions so far`, or a fresh `decision` ticket.

## First-time config offer (end of chart / adopt)

Charting hand-resolves nothing, so a fresh chart or adopt closes with this offer. When a project has a map but **no `.trailhead/config.json` yet**, put an **explicit two-way choice** to the user and wait for their pick: **(a) accept as-is** (continue on the current or proposed values, which writes an empty `{}`), or **(b) run `/trailhead:config`** to configure everything through the guided menu (models / design / TDD / ...). **Always name both paths and let the user choose; never silently take one.** You may show the values you would default to, but frame the close as this binary: **do not** pre-fill the config keys and ask for an open-ended inline edit, and **do not** interview the user key-by-key inline (that is `/trailhead:config`'s job). Ask this **only once**: running config writes the file, and *accept as-is* writes an empty `{}`, so once `.trailhead/config.json` exists it is never offered again (a `{}` file means "reviewed, using defaults").
