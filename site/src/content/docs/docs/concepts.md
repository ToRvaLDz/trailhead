---
title: Core concepts
description: Maps, tickets, the frontier, the fog, and the repo-scoped anchor issues.
---

## Map

A **map** is one GitHub issue labelled `trailhead:map`. It's an index, not a store: a Destination, standing Notes, the `Decisions so far`, the `Not yet specified` fog, and what's `Out of scope`.

**What earns a map?** A map is the unit for an effort that is too big to hold in one session and carries open decisions, not just execution. In practice that's a milestone (a release, a version, "v2 of the dashboard"), or a single feature big enough that you must decide before you can build it: where the data lives, which library, what the screen actually does. Charting a map names its destination and fans that effort out into many tickets, wired by their dependencies. As the decisions resolve, the fog clears and the build tickets graduate, until the destination is reached.

What does **not** need its own map is a single, defined piece of work with no open questions, small enough to finish in one session. That's just one ticket, a direct `build` (or a `todo`): a work you take with `/trailhead:work` and resolve in a sitting, no charting required.

**Rule of thumb:** decisions to make, or too big for one sitting → a map; "just do X" → a single work. A feature that starts as a lone work but turns out to need decisions gets promoted to its own map (or split); a map whose questions all evaporate collapses back to a handful of works. A repo can hold several maps at once (parallel milestones or features), each with its own frontier.

## Ticket

Each **ticket** is a child issue with a type label and a one-question body. See [Ticket types](/docs/ticket-types) for the six types and their engines.

## Frontier

The **frontier** is the set of open, unassigned tickets whose blockers are all closed: what's takeable right now. You claim a ticket by assigning it to yourself, resolve it with the engine for its type, then record the answer as a comment, close it, and gist it back onto the map.

## Fog

As tickets resolve, the fog clears: questions that were too vague to phrase become sharp enough to ticket, one at a time, until nothing is left to decide or build and the destination is reached. See [Workflow](/docs/workflow) for how a loose suggestion moves from inbox through fog to a graduated ticket.

## Repo-scoped anchors

A map is scoped to **one** effort, so knowledge that belongs to the *repo* (not to any single map) lives in repo-scoped anchor issues, created once and shared by every map (each map's Notes just links them, so nothing is stranded when a map finishes):

- **`trailhead:codebase`**: the distilled codebase map (architecture, stack, conventions, risks, test/build), written once at adopt and refreshed only on major drift.
- **`trailhead:conventions`**: the project's way of working, readable by everyone: a small machine-read header the engine obeys (`git: main|pr`, `release: command|auto`, `isolation: none|worktree|clone`) over human prose. `/trailhead:adopt` and `:new` ask for it up front.
- **`trailhead:dashboard`**: the pinned index of the whole surface: a link to every open map, the whiteboard, and live counts (inbox, whiteboard frontier).

These three fill GitHub's 3 pinned-issue slots, so a repo's trailhead anchors stay one click away; maps themselves are never pinned (they're indexed by the dashboard instead). Project *config* (models, TDD, design…) is separate again, a plain `.trailhead/config.json` file at the repo root, never in an issue. See [Configuration](/docs/configuration).

## Labels

Everything the map needs is expressed as GitHub labels, so state is queryable in the tracker UI:

- **Structural:** `trailhead:map`, `trailhead:ticket`
- **Repo-scoped anchors (one each per repo, pinned):** `trailhead:codebase`, `trailhead:conventions`, `trailhead:dashboard`
- **Type (one per ticket):** `trailhead:decision` · `research` · `prototype` · `build` · `bug` · `task`
- **State:** `trailhead:blocked` (has an open blocker) · `seed` (parked on a trigger) · `out-of-scope` (closed, beyond the destination) · `superseded` (closed, split into children)
- **Container:** `trailhead:whiteboard` (a loose, map-less ticket, off every map's frontier, on the whiteboard's own)

The frontier is then a single query (open, unassigned, not `trailhead:blocked`), no body-parsing needed.

Next: [Ticket types](/docs/ticket-types) for how each type is resolved, or [Commands](/docs/commands) for the full verb list.
