# Capture: the verbs in detail

Capture without breaking flow, but with the **tracker** as destination, not scattered files. The verbs are in the **Capture** table in SKILL.md's Commands section; here is the detail of each. One capture = one action + one confirmation line; it resolves nothing.

**Confirmation line.** Confirm the capture by the ticket's name (not a bare `#number`) and where it landed. **If you point at working it later, lead with `/clear`**: the confirmation is a place you point at the next ticket, so the [Session handoff](../SKILL.md)'s `/clear`-first rule applies: a compact, future-conditional one-liner is fine (a capture is not a resolution, so no full labelled block), along the lines of *"to work it later: `/clear`, then `/trailhead:work 45`"* (in the user's conversation language). Never a bare `/trailhead:work 45` with no `/clear`.

**Language (do not skip):** the captured ticket (title + body) is written in `config.ticket.language` (default `en`), **regardless of the language you are chatting in**. A capture fired in Italian still lands as an English ticket. This is the easiest place to slip, because a capture echoes the user's one-line phrasing; translate it, do not mirror it. See SKILL.md's *Ticket language* rule.

**Map or whiteboard:** a capture that produces a **ticket** (`todo`, `bug`, `seed`, and `idea` when it is sharp enough) must land on a **map** or on the **whiteboard** (map-less). **When a map is open, ask the user which** before creating it (active map vs whiteboard; several maps open -> the ask also picks the map). Whiteboard tickets get the `trailhead:whiteboard` label and **no** map label or `Parent:`; map tickets get the map's `trailhead:map-<n>` label + native sub-issue edge. **No map open at all -> whiteboard, no ask** (nowhere else to go). `note` and a non-sharp `idea` stay map-fog and skip this; with no open map they fall back to the global notes location (`$HOME/.claude/notes/`), or a now-sharp `idea` becomes a whiteboard ticket. **When a capture creates a whiteboard ticket, refresh the pinned dashboard** afterwards (a structural event: the whiteboard surface the dashboard indexes grew, and a whiteboard ticket has no native progress bar, so the dashboard is the only place it shows); a capture landing on a *map* does not (native sub-issue progress bars track map tickets). See SKILL.md's *Capture*, *The whiteboard*, and the dashboard freshness rule.

- **`note`** → a verbatim line in `## Not yet specified` (outside a project → `$HOME/.claude/notes/`). No questions, no rewriting.
- **`idea`** → fog by default in `## Not yet specified`; becomes a ticket only if already phrasable as a sharp question. An idea in the fog is **not executable**: to work it, it must first **graduate** into a ticket (which happens when the frontier reaches it, or when you can now phrase it sharply). A `todo`, by contrast, is born a `build` ticket and is workable immediately.
- **`todo`** → a small `trailhead:build` ticket on the frontier (defined work you will do: a todo is just a small build ticket). If it's a parking spot *beyond* the destination, it goes in `## Out of scope` instead.
- **`bug`** → a `trailhead:bug` ticket on the frontier; the repro in the body if you know it. If it blocks the ticket you're working, add it to that ticket's `## Blocked by` and label that ticket `trailhead:blocked`. Pass **`--of <ticket>`** (a number, `#n`, name, or URL) to record it as a `Regression of: <ticket>` pointer in the body; use it for a bug in already-closed work, which is always a *new* ticket, never a reopen (see the `bug` engine for the reopen exception). **Don't derail**: capture and continue; you resolve it in a dedicated session.
- **`seed`** → a ticket labelled `trailhead:seed` + `trailhead:blocked`, kept in its own `## Blocked by` until the trigger fires; note the trigger in the body. When the trigger fires, drop both labels to graduate it onto the frontier.

**note · idea · seed · todo form a spectrum** of commitment and timing (`bug` is separate: a defect, not a capture-tier):

| Verb | Lands as | Workable when | Meaning |
|---|---|---|---|
| **note** | verbatim text (fog, or global notes) | maybe never, just recorded | *remember this* (not necessarily work) |
| **idea** | fog (`Not yet specified`) | later, **if** it graduates to a ticket | *maybe I'll do it* |
| **seed** | a blocked ticket | when a **trigger** fires | *I'll do it when X happens* |
| **todo** | a frontier ticket | **now** | *I'm doing it* |

Discriminator: not even work → `note`; maybe, once it's clear → `idea`; yes, when X happens → `seed`; yes, now → `todo`. The close pairs: `note` vs `idea`: raw text vs a work-candidate meant to graduate; `idea` vs `seed`: waiting on *clarity* vs waiting on a *condition*; `seed` vs `todo`: committed *later* vs committed *now*.
