---
title: Captures & the whiteboard
description: Zero-friction capture, the commitment spectrum, the whiteboard, and lineage pointers.
---

## Don't get trapped in a map: the whiteboard

Deep in a map, something unrelated surfaces: a bug in another area, a chore, a quick idea you want to act on now. Forcing it onto the map's frontier pollutes the map; charting a whole new map for it is overkill. That's what the **whiteboard** is for — loose, map-less work — and two moves keep you from getting stuck:

- **Capture it aside.** A `todo`/`bug`/`seed`/sharp `idea` fired while a map is open asks *map or whiteboard?*. Send it to the whiteboard and it stays off the map: tracked, but out of the way, so the map's frontier keeps meaning "the way to this destination".
- **Do it on the fly.** `/trailhead:quick "<text>"` opens a whiteboard ticket and works it end to end in the same sitting — the full discuss → plan → execute → verify engine (atomic commits, code review, the lot) — except it grills only if needed and never splits, and skips every map book-keeping step. `/trailhead:quick <n>` does the same for a ticket that already exists.

See the whole whiteboard with `/trailhead:whiteboard`. Nothing about the map changes: you just stepped off it, did the thing, and step back on when you're ready.

When a map is open, a capture that produces a ticket (`todo`/`bug`/`seed`/a sharp `idea`) asks whether to file it on the active map or the whiteboard, the home for loose, map-less work that doesn't belong to any map (or isn't worth charting one). With no map open it lands on the whiteboard.

## The commitment spectrum: note, idea, seed, todo

The three that trip people up are **idea, seed, todo**, so here they are spelled out:

- **`idea`** = *maybe, and not yet clear.* It lands in the **fog** (`Not yet specified`), not as a ticket, because you can't even phrase the question sharply yet, so there is nothing to work. It graduates into a ticket later, when the frontier reaches it or it simply gets clearer.
- **`seed`** = *yes, but not yet.* It **is** a ticket, but parked (`trailhead:blocked`) on a trigger you name ("when the public API ships", "when we pass 1k users"). The question is already sharp; what's missing is a condition, not clarity. When the trigger fires, it graduates onto the frontier.
- **`todo`** = *yes, now.* Defined work you will just do: it's born a `build` ticket on the frontier, takeable immediately.

The two cuts that matter: **idea vs seed** is waiting on *clarity* vs waiting on a *condition* (both land "later", for different reasons); **seed vs todo** is committed *later* vs committed *now*. Below all three sits **`note`** (raw text to remember, maybe never work), and off to the side is **`bug`** (a defect, not a commitment tier).

The test for idea vs ticket is always: can you phrase the question precisely now? Yes → a ticket (`todo` if takeable, `seed` if gated); no → the fog (`idea`).

## Keeping tickets honest

A ticket is one answerable Question, sized to one session, so you never grow it in flight. When new scope surfaces while you're working (testing especially sparks ideas), you decide per idea: small and part of the same Question → just do it; balloons the ticket past one session → split it; separate work or a follow-up → capture it (`idea`/`todo`/`ticket`/`bug`) and keep going. Extras never become silent lines inside the ticket you're on.

Tickets that spin off from other work carry a lineage pointer in their body, so the map stays traceable:

| Pointer | Meaning |
|---|---|
| `Split from:` | a child of a ticket that was split |
| `Regression of:` | a bug in the work of a closed ticket |
| `Surfaced from:` | an idea/ticket that came up while working another ticket |

Next: [Commands](/docs/commands) for the exact capture syntax, or [Workflow](/docs/workflow) for how a capture fits into the lifecycle loop.
