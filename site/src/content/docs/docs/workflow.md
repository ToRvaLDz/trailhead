---
title: Workflow
description: The lifecycle loop, a worked example, and how outside suggestions graduate onto the map.
---

## The lifecycle

Every project walks the same loop:

1. **Start**: `/trailhead:new "<idea>"` (greenfield) or `/trailhead:adopt` (existing code: map the codebase once, then go lean). This charts the map: name the destination, then map the frontier breadth-first into the first tickets and the fog.
2. **Work the frontier, one ticket per session**: `/trailhead:work` takes the next takeable ticket (or one you name) and runs the engine for its type: `research` gathers a fact, `decision` diverges options then grills to choose, `prototype` makes a rough artifact to react to, `build` runs discuss → plan → execute → verify, `bug` runs repro → diagnose → fix → verify, `task` is manual plumbing that unblocks a decision.
3. **Close & unblock**: resolve the ticket (comment + close), gist it into `Decisions so far`, and drop `trailhead:blocked` from any dependent whose last blocker just closed, graduating it onto the frontier.
4. **Repeat** until the frontier is empty and the fog has cleared: the destination (a working artifact) is reached.

Along the way: capture ideas mid-work without derailing (see [Captures & the whiteboard](/docs/captures)), split a ticket that grew too big, pause/resume across sessions, and let several people work unblocked tickets in parallel (see [Working as a team](/docs/teamwork)).

## Autonomous run: `auto`

`/trailhead:auto [map]` chains the frontier unattended: it takes one ticket after another (suspending the one-ticket-per-session rule) and resolves each with its normal type engine, instead of handing back to you between tickets.

It stops only at:
- the **safety rail** (always on, hardcoded): cutting a release, `git push`, opening a PR, a delete/force, or any other outward-facing action. Atomic local commits to `main` are not rail-tripping and continue automatically.
- **fog** that needs a human to dissolve it into tickets.
- a **human-necessary decision**: a `decision`-ticket convergence, a destination or scope change, an out-of-scope ruling, routing a deferred line, closing an exhausted map, a claim collision.
- a **human-only step**: a HITL `task` (manual plumbing only you can do, like signing up for a service); auto hands you the checklist rather than fabricating it.

Under a **`git: pr`** convention (or worktree/clone isolation) a ticket finishes with a branch push and a PR, both rail actions, so auto does each ticket's whole local cycle and then sets the push/PR/integration aside for you: it is most productive under `git: main`, where a resolved ticket closes and unblocks its dependents immediately.

A ticket a run cannot verify is not left hanging: it gets a bounded **failure budget** (a no-progress rule plus a hardcoded ceiling of 3 extra rounds), and at exhaustion the run **pauses that ticket, keeping its claim, and skips to the next** rather than stopping the whole run.

**Interruption** is just the host interrupt (Stop/Esc): the in-flight ticket keeps its claim and gets a `PAUSED` checkpoint. **Resume** is you re-invoking `/trailhead:auto`; it never re-engages on its own.

`auto` is **orthogonal to `effort` and `models.*`**: it changes neither, and it has **no config surface of its own** (there is nothing to configure).

## A worked example: "add social login"

Destination: *users sign in with Google and GitHub, alongside email/password.* Charting fans it into six tickets (one of each type) wired by their dependencies:

```
① research   "OAuth providers + library: Supabase Auth native or Auth.js?"   ← frontier (AFK)
② decision   "approach: Supabase Auth native vs Auth.js custom"              ← blocked by ①
③ task       "register OAuth apps on Google + GitHub, get client id/secret"  ← frontier (HITL)
④ prototype  "how the login screen with social buttons looks"                ← frontier (HITL)
⑤ build      "implement Google + GitHub login"                               ← blocked by ②③④
⑥ bug        (appears after ⑤ ships)
```

Initial frontier = ①③④, three people can start in parallel. Then:

- **① research** → a subagent reads the docs, returns a decision-ready finding, closes → unblocks ②.
- **② decision** → diverge the options, grill to choose native vs custom, record the why.
- **③ task** → the agent hands you a checklist (it needs *your* Google/GitHub accounts); you register the apps, it records where the credentials live.
- **④ prototype** → a rough login screen (on the configured design surface), approved before UI code.
- With ②③④ closed, **⑤ build** graduates → discuss → plan → execute (atomic commits, TDD at the auth seams) → verify (tests + code review + acceptance: the agent drives the browser through the real login flow).
- After it ships you spot a wrong redirect in prod → `/trailhead:bug --of ⑤ "GitHub redirect goes to localhost"` → a new ticket carrying `Regression of: ⑤`, worked repro → diagnose → fix → verify. ⑤ stays closed.

```
① research ─┐
③ task ─────┼─► ② decision ─┐
④ prototype ┘                ├─► ⑤ build ──(ship)──► ⑥ bug (Regression of: ⑤)
③ task ──────────────────────┘
```

The preparatory types (`research`/`decision`/`prototype`/`task`) unblock the constructive ones (`build`/`bug`); parallelism is real but across sessions on the frontier, not inside one.

## …then a suggestion arrives: inbox → fog → graduation

The app is live, and a user not on the team files a plain issue: *"can we add Apple sign-in too?"* No `trailhead:*` label, so it isn't a ticket yet. Here's how an outside voice becomes a first-class ticket on the map, without losing the reporter's authorship:

1. **Inbox**: `/trailhead:inbox` lists it under *New: to triage*. It's in scope but not sharp: web only or native? does it need the paid Apple Developer account? You can't phrase one answerable Question yet, so you don't force a ticket.
2. **Fog**: label it `trailhead:fog` and keep the issue open as a clarification space. A comment posts the sharpening questions (async grilling); the reporter and anyone interested refine it in the thread. It's off the frontier but tracked: `gh issue list --label trailhead:fog` is the durable list, and the reporter follows their own issue.
3. **Graduation**: the discussion converges. Next time you run `/trailhead:inbox`, its *Parked fog* section surfaces the thread as recently-active: that's how you notice the fog cleared. Now the Question is phrasable, so you adopt it in place: swap `trailhead:fog` for `trailhead:ticket` + a type label, add the `Parent:` line and the `## Question`. Same issue number, same reporter credited, it lands on the frontier, ready for `/trailhead:work`.

```
suggestion issue ──inbox──► fog (kept open, discussed) ──sharpens──► ticket on the frontier
                                                                    (same #, reporter still credited)
```

No separate backlog, no lost credit: the map absorbs external suggestions the same way it grows its own, through fog that graduates when it's sharp.

Next: [Ticket types](/docs/ticket-types) for what each engine actually does, or [Commands](/docs/commands) for the full verb list.
