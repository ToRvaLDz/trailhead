---
title: "View commands"
description: "map, dashboard, and whiteboard: the renders that show where the work stands."
---

The view verbs present state. They change nothing on the tracker, with a few exceptions noted per verb: the dashboard's create-and-pin self-heal, and a map close that only happens on your explicit yes. No isolation workspace is set up for them. Back to the [command index](/docs/commands).

### /trailhead:map

Show the low-res map: destination, decisions, frontier, fog.

**Syntax**

```
/trailhead:map [map]
```

**Arguments**

- `map` (optional): a map number. `/trailhead:map <n>` shows that map and makes it the active one. Without it, trailhead uses the active map (`.trailhead/active-map`); with no active map and more than one open, it lists them and asks.

**What it does**

1. Makes sure the repo's pinned dashboard exists and is pinned (see `dashboard` below), creating or re-pinning it only if needed.
2. Renders the map by name: Destination; Frontier (takeable now, each with its type, shown as a set to choose from rather than a ranked list; whiteboard tickets are excluded); In progress (with who holds each); Blocked (with what each waits on, and an advisory line if the written `## Blocked by` differs from the native dependency); Decisions so far; Not yet specified and parked fog (each top-level fog entry numbered for that render so you can name one); Out of scope; and an inbox count.
3. Flags any Out of scope line that is really deferred (a gate, a "for now" qualifier, a feature wanted later) and suggests `/trailhead:inbox` to re-route it.
4. If the map is exhausted (no open tickets and no fog left), says so and asks whether to close the map issue. A yes closes it and refreshes the dashboard; a no leaves it open. It never closes unprompted.

**What it writes**

- Nothing on the map, except the map close when you say yes. The fog numbers are a render-time handle and are never saved into the map body.
- The dashboard, only if it was missing (created and pinned) or unpinned (re-pinned); never a body rewrite on a render.
- With `<n>`, the local `.trailhead/active-map` marker.

**Example**

```
/trailhead:map
```

trailhead prints the destination, the frontier tickets you could take now, who holds what, the blocked ones, the settled decisions and the numbered fog.

### /trailhead:dashboard

Show the repo dashboard: the pinned index of every open map, the whiteboard, and live counts.

**Syntax**

```
/trailhead:dashboard
```

**Arguments**

None.

**What it does**

1. Finds the repo's `trailhead:dashboard` issue, creating and pinning it if missing (it takes the fixed third pinned slot beside the codebase and conventions issues).
2. Regenerates its body from the live tracker and shows it: a link to every open map (GitHub renders each map's progress bar natively), the whiteboard section, and counts such as the untriaged inbox size and the whiteboard frontier size.
3. Flags each open map that is exhausted but still open as `exhausted · closeable` and offers to close it, routing any deferred Out of scope line first. It flags a map near GitHub's 100 sub-issue cap as `near cap · <total>/100` (or `at cap`, with `· prunable` when closed edges can be reclaimed) and offers `/trailhead:prune`. Both are offers only, never automatic.

**What it writes**

- The pinned dashboard issue body, as a full regeneration (the on-demand refresh). A hidden `trailhead:last-audit` marker already in the body is preserved, since `/trailhead:audit` uses it.
- The dashboard otherwise refreshes on structural events (a map charted or exhausted, a whiteboard ticket born or resolved), not on every map ticket resolve.

**Example**

```
/trailhead:dashboard
```

trailhead refreshes the pinned index and shows two open maps, the whiteboard with three loose tickets, and a note that one map is `exhausted · closeable`, with an offer to close it.

### /trailhead:whiteboard

Show the whiteboard: loose, map-less tickets, their frontier and who holds each.

**Syntax**

```
/trailhead:whiteboard
```

**Arguments**

None.

**What it does**

1. Makes sure the pinned dashboard exists and is pinned (same self-heal as `map`).
2. Renders the whiteboard by name: Frontier (open, unassigned, unblocked `trailhead:whiteboard` tickets, each with its type, as a set to choose from), In progress (claimed tickets and who holds each), and Blocked (with what each waits on). Unlike a map it has no destination, decisions or fog: it holds only loose work.
3. Pick a frontier ticket with `/trailhead:work <n>` (works it whole and can split) or `/trailhead:quick <n>` (no split).

**What it writes**

Nothing. It is a read-only render; the dashboard is touched only if it was missing or unpinned.

**Example**

```
/trailhead:whiteboard
```

trailhead lists, for example, a `todo` and a `bug` on the frontier, one ticket in progress under a teammate, and one blocked ticket with its blocker.

Next: [capture commands](/docs/commands/capture) for adding to the map or the whiteboard in one line. See also [Captures & the whiteboard](/docs/captures).
