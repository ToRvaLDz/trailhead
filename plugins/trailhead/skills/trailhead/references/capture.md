# Capture: the verbs in detail

Capture without breaking flow, but with the **tracker** as destination, not scattered files. The verbs are in the **Capture** table in SKILL.md's Commands section; here is the detail of each. One capture = one action + one confirmation line; it resolves nothing.

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
