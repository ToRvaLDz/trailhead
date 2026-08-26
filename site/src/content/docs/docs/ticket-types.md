---
title: Ticket types
description: The six ticket types, their engines, and two rules of thumb.
---

Each ticket carries a type label; each type has its own way of being resolved. Each type has its own inline engine: no external skill is invoked.

| Type | Produces | Mode | Engine |
|---|---|---|---|
| `decision` | a choice | HITL | diverge the options if unclear, then grill to converge on one |
| `research` | a fact | AFK | a subagent on a throwaway branch (the only type run in parallel) |
| `prototype` | an approved direction | HITL | a rough throwaway artifact to react to; UI screens go through this (disk, or a configured design surface) before UI code |
| `build` | working code | HITL/AFK | `discuss → plan → execute → verify`: atomic commits, TDD at seams, a mockup first for user-facing UI (gated by `design.approval`), code review + acceptance testing (browser-drive or conversational step-by-step UAT) |
| `bug` | corrected code | HITL/AFK | `repro → diagnose → fix → verify`; a defect in closed work is a *new* ticket (`Regression of:`), not a reopen |
| `task` | an external state change | HITL/AFK | manual work that unblocks a decision (provision access, move data, sign up) |

## Two rules of thumb

- Build tickets never auto-grill: on blocking ambiguity the skill stops and asks.
- Brainstorming (divergence) lives in charting, in `ticket`'s micro-charting, and in a `decision`'s option phase, never in the grilling itself, which only converges.

Next: [Commands](/docs/commands) for the verbs that drive each type, or [Core concepts](/docs/concepts) for the map/ticket/frontier vocabulary these engines operate on.
