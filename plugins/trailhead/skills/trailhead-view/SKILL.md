---
name: trailhead-view
description: "trailhead view cluster: the read-only renders of the trailhead surface. Show the low-res map: destination, decisions, frontier, fog (map); regenerate and show the pinned per-repo dashboard indexing every open map plus the whiteboard (dashboard); show the whiteboard of loose map-less tickets (whiteboard). A cohesion cluster of the trailhead skill split, loading the shared `_shared/` core; reached through the `/trailhead:<verb>` command wrappers. Not auto-invoked: it runs only when one of these verbs is dispatched."
argument-hint: "[map|dashboard|whiteboard] [map]"
---

`trailhead-view` is the **view cluster** of the trailhead skill: the read-only renders of the trailhead surface. `map` renders the low-res map (destination, decisions, frontier, fog); `dashboard` regenerates and shows the pinned per-repo index of every open map plus the whiteboard; `whiteboard` renders the loose, map-less tickets. These verbs present state; they change nothing on the tracker, with two exceptions: the dashboard's create-and-pin self-heal, and a user-confirmed map close in the map's exhaustion check. Everything lives on the GitHub Issues; the repo holds code only.

## Load first, in order

Before doing anything, read the shared core (paths relative to this file):

1. `../_shared/principles.md`: refer by name, result-oriented output, no em-dashes, git per conventions, one ticket per session.
2. `../_shared/ticket-language.md`: write all Issue prose and commit bodies in `config.ticket.language` (default `en`), independent of the chat language.
3. `../_shared/substrate.md`: the GitHub-Issues model: labels, the frontier query, the map / ticket / dashboard / whiteboard anatomy, and the base-command cookbook pointer.
4. `../_shared/session-handoff.md`: how every resolution closes (`/clear` first, then the next command).
5. `../_shared/configuration.md`: the three config layers and the load contract.
6. `../_shared/techniques.md`: the technique index and the subagent-type rule.

Load the **effective config** (per `../_shared/configuration.md`) at session start, from the map's project root (`.trailhead/config.json` plus the global file). These are read-only renders: no isolation workspace is set up.

## Routing: verb to engine

The **first word** of the arguments is the verb; the rest is an optional map selector.

- **`map [map]`** to the **Render the map** engine below.
- **`dashboard`** to the **Render the dashboard** engine below.
- **`whiteboard`** to the **Render the whiteboard** engine below.

The cross-cluster situational references these renders call live in `_shared/`; this cluster names each by its `../_shared/...` path where it needs one (the gh cookbook for the dashboard commands, the out-of-scope rules). The multi-cluster model, the frontier-order and blocked-by-drift rules, and the handoff are also in `_shared/`.

## Render the map: `map [map]`

A single `trailhead:map` issue is the canonical artifact: an **index**, not a store, listing the decisions made and pointing at the tickets that hold their detail. A decision lives in exactly one place (its ticket); the map gists it and links.

**`map`** renders it at low resolution as a read-only view (it changes nothing on the map itself, except the user-confirmed close in the exhaustion check below), the map body plus the live ticket state, by name. **Pick which map** if the repo has several open: use the one the user named (`map <n>` shows that one and makes it active), else the active map (`.trailhead/active-map`); with no active map and more than one open, list them and ask which. See **Multiple maps on one repo** in `../_shared/multi-map.md`.

Render, by name:
- **Destination**: the one-line where-we're-headed.
- **Frontier**: takeable now (open, unassigned, not blocked/unverified, and **not** `trailhead:whiteboard`, which has its own view), each with its type. Present independent tickets as a **set to choose from**, not a crowned first (see **Frontier order carries no priority** in `../_shared/substrate.md`).
- **In progress**: claimed tickets, with who holds each.
- **Blocked**: with what each waits on; flag any **blocked-by drift** (prose `## Blocked by` differs from the native dependency, see **Blocked-by reconciliation** in `../_shared/substrate.md`) as an advisory line.
- **Decisions so far**: the index of what's settled.
- **Not yet specified** + **parked fog**: the coarse fog, and a count/link of open `trailhead:fog` issues.
- **Out of scope**: what's been ruled out; **flag as an advisory** any line that's actually **deferred** rather than truly beyond the destination (the tells: a gate/trigger, a this-only qualifier, a feature wanted later, or the gate of a live `trailhead:seed`; see `../_shared/out-of-scope.md`), unless it's already parked (`→ future map` with dependent seeds on a live trigger, in which case say nothing). **Name any un-parked ones and suggest `/trailhead:inbox` to re-route them** (seed/idea/todo).
- **Inbox**: a count of untriaged inbound issues, as a nudge.
- **Exhaustion check**: if the map is exhausted (no open tickets and no fog left: the destination is reached), **say so and ask whether to close the map issue**, the same ask as the work handoff: on a yes, `gh issue close` it and refresh the dashboard so it drops off; on a no, leave it open. Maps aren't pinned, so there's no pin to free either way. Never close unprompted. Route any un-parked deferred *Out of scope* line first (above) so nothing wanted-later is lost. This user-confirmed close is the only change `map` makes to the map, and only on an explicit yes (the dashboard self-heal below touches only the pinned index, never the map).

**Dashboard self-heal.** Before rendering, ensure the repo's pinned `trailhead:dashboard` index exists and is pinned: create + pin it only if missing, re-pin it if the pin was dropped, and otherwise do nothing (never rewrite its body on a render). This is the same self-heal the **Render the dashboard** engine documents below; the exact gh commands are in `../_shared/substrate-commands.md`.

The map body it renders (the sections are matched by their **text**; the emoji are cosmetic anchors):

```markdown
## 🎯 Destination
<what reaching the end of this map looks like: the spec, decision, or change this effort tends toward. The working artifact, unless overridden. One or two lines; every session orients to it before choosing a ticket.>

## 🗒️ Notes
<domain; vocabulary; standing preferences for this effort; any "stop at the spec" override; a link to the repo's `trailhead:codebase` issue and a link to the repo's `trailhead:conventions` issue (the way of working: git/release + notes). Config is NOT here: it lives in `.trailhead/config.json` at the repo root.>

## ✅ Decisions so far
<!-- the index: one line per closed ticket -->
- [<closed ticket title>](link): <one-line gist of the answer>

## 🌫️ Not yet specified
<!-- fog of war: in-scope fog not yet ticketable; graduates as the frontier advances -->

## 🚫 Out of scope
<!-- work ruled beyond the destination; closed, never graduates -->
```

So `Decisions so far` / `Not yet specified` / `Out of scope` refer to these blocks throughout.

## Render the dashboard: `dashboard`

A repo's trailhead surface is spread across issues: one or more maps, a whiteboard, an inbox. The **dashboard** is the single pinned entry point that indexes all of it: a permanent, repo-scoped issue labelled **`trailhead:dashboard`**, created once at the first chart/adopt and occupying the **fixed 3rd pinned slot** alongside `trailhead:codebase` and `trailhead:conventions` (see `../_shared/substrate.md`). Maps themselves are **never pinned**: a pin is server-side and global to the repo, but the active map is client-side per-checkout state (`.trailhead/active-map`, gitignored), so no single map is "the" map to pin. The dashboard gives one stable pinned index that scales to any number of maps and to the whiteboard.

It holds:
- a link to **every open `trailhead:map`** (found via the `trailhead:map` label); GitHub renders each map's sub-issue **progress bar natively**, so the dashboard only links, it never recomputes per-ticket progress;
- the **whiteboard** as its own section (frontier / in-progress / blocked, or a link to the `whiteboard` view);
- dynamic **counts**: untriaged inbox size, whiteboard frontier size.

**`dashboard`** regenerates the pinned issue body from the live tracker and shows it, both the render and the on-demand refresh, consistent with `map` and `whiteboard`. It creates and pins the issue if the repo doesn't have one yet (ensuring the `trailhead:dashboard` label first, idempotently). The exact gh commands (find, pin/re-pin/unpin, self-heal, body generation with the count queries) are in `../_shared/substrate-commands.md`.

**Freshness: structural events + on demand.** The pinned issue is rewritten when the surface changes **structurally** and **on demand** via `dashboard`. The structural events are: a map is **charted** or **exhausted** (a map appears or disappears), and a **whiteboard ticket is born or resolved**. It is **not** rewritten on every *map* ticket resolve: that would churn a pinned issue (and its notifications) constantly, and each map's native sub-issue progress bar already tracks its per-ticket progress. **The whiteboard has no such native progress bar** (its tickets are sub-issues of nothing), so the dashboard's whiteboard section and count are the only place whiteboard state shows: a whiteboard ticket appearing or being resolved *is* a structural change to the indexed surface, and refreshes the dashboard. Links + counts stay good enough refreshed at these events and on demand.

**Self-heal (read-only entry points).** A repo that adopted trailhead before the dashboard existed, or one whose pin was later dropped, has no pinned index until the next chart/adopt or an explicit `dashboard`. To close that gap, the frequent **read-only entry points self-heal the pin**: the bare `/trailhead` smart entry, the `map` render, and the `whiteboard` render each ensure the dashboard exists and is pinned before rendering, idempotently and cheaply, mirroring the "ensure the label exists before applying it" pattern: ensure the `trailhead:dashboard` label, then
- **if no dashboard issue exists**, create it, write the current surface once, and pin it (the fixed 3rd slot);
- **if it exists but is unpinned** (a dropped pin is exactly the drift to self-heal), re-pin it;
- **if it exists and is already pinned**, do nothing.

**Create + pin only when missing: never rewrite the body on the read-only renders.** `map` and `whiteboard` are frequent read-only views, not the on-demand refresh, so the freshness rule above holds unbroken (`dashboard` and structural events stay the only writers of the body). The one body write those paths ever make is the initial one at creation (the dashboard appearing is itself a structural event).

## Render the whiteboard: `whiteboard`

Not all work belongs to a map. A **bug**, a **todo**, or a one-off **task** may be about something else entirely, or simply not worth charting a map for. The **whiteboard** is where that loose work lives: tickets labelled **`trailhead:whiteboard`**, map-less (no `trailhead:map-<n>` label, no `Parent:` line, no native sub-issue edge). A ticket is on a map **or** on the whiteboard, never both. Loose tickets are created there by a capture routed to the whiteboard or born there by `quick`, and worked with `quick <n>` or `work <n>` (the capture and work clusters own those paths). This engine only **renders** the whiteboard.

It has its **own frontier**, off every map's (see **Map frontier vs whiteboard frontier** in `../_shared/substrate.md`):
```bash
gh issue list --label "trailhead:ticket" --label "trailhead:whiteboard" --state open \
  --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
```

**`whiteboard`** renders this as a read-only view, a mirror of the `map` render minus destination, decisions, and fog (the whiteboard has no direction, only loose work), by name:
- **Frontier**: takeable now (open, unassigned, not blocked/unverified whiteboard tickets), each with its type. Present independent tickets as a **set to choose from**, not a crowned first (see **Frontier order carries no priority** in `../_shared/substrate.md`).
- **In progress**: claimed whiteboard tickets, with who holds each.
- **Blocked**: any blocked whiteboard ticket, with what it waits on (a whiteboard ticket can still block on another).

**Dashboard self-heal.** Like the `map` render, ensure the repo's pinned `trailhead:dashboard` index exists and is pinned before rendering (create + pin only if missing, re-pin if the pin was dropped; never rewrite its body here). See the **Render the dashboard** self-heal above.
