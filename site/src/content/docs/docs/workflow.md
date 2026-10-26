---
title: Workflow
description: The lifecycle loop, a worked example, and how outside suggestions graduate onto the map.
---

## The lifecycle

Every project walks the same loop:

1. **Start**: `/trailhead:new "<idea>"` (greenfield) or `/trailhead:adopt` (existing code: map the codebase once, then go lean). This charts the map: name the destination, then map the frontier breadth-first into the first tickets and the fog.
2. **Work the frontier, one ticket per session**: `/trailhead:work` takes the next takeable ticket (or one you name) and runs the engine for its type: `research` gathers a fact, `decision` diverges options then grills to choose, then opens the build tickets that carry the answer, `prototype` makes a rough artifact to react to, `build` runs discuss → plan → execute → verify, `bug` runs repro → diagnose → fix → verify, `task` is manual plumbing that unblocks a decision.
3. **Close & unblock**: resolve the ticket (comment + close), gist it into `Decisions so far`, and drop `trailhead:blocked` from any dependent whose last blocker just closed, graduating it onto the frontier.
4. **Repeat** until the frontier is empty and the fog has cleared: the destination (a working artifact) is reached.

Along the way: capture ideas mid-work without derailing (see [Captures & the whiteboard](/docs/captures)), split a ticket that grew too big, pause/resume across sessions, and let several people work unblocked tickets in parallel (see [Working as a team](/docs/teamwork)).

## Autonomous run: `auto`

`/trailhead:auto [map]` drains a map (or the whiteboard, or everything) unattended: it takes ticket after ticket, in 1 to 4 parallel slots, and resolves each with the same engine `/trailhead:work` would run, without handing back to you in between. It never starts on its own: you launch every run.

**`auto` or `work`?** Both resolve tickets; what changes is who stays in the loop. `/trailhead:work` is the interactive mode: one ticket per session, and it stops to ask you along the way (the scope brief, grilling, acceptance). `auto` asks only at the start, then makes the process choices itself and parks for you whatever only you can settle. Use `auto` for well-specified build and bug tickets you don't need to steer; use `work` for decisions, fuzzy tickets, or when you want to drive.

**When you come back** you find the run report in chat (also posted on each touched map), the tickets that need you labelled `trailhead:needs-you` with a `NEEDS YOU` comment, and local commits waiting for you to push: the run never pushes.

While it runs, the chat shows a progress line naming the tickets in the slots and what just resolved or comes next; at the end, the run report. Something like:

```text
auto: slot 1 #42 add social login (verify) | slot 2 #43 session cookie (execute) | resolved #41, next #44

Run report
Stopped:  frontier empty
Resolved: #41, #42, #43, #44
Merged:   #41, #42, #43, #44 into main; local main is 7 commits ahead of origin (pushing is yours)
Remains:  #45 needs you (which providers to support); #46 blocked by #45
```

**Main checkout.** With more than one slot, the run merges each verified slot branch into the local trunk of the main checkout (a fast-forward when possible, else a merge commit), so if you are working in that checkout by hand your branch can move under you. Uncommitted tracked work stays protected: the merge stops on a dirty tree and the ticket is parked needs-you. Untracked files do not trip that check (one in the way of a file the merge brings in still stops it, parked the same way).

### What it asks first

Before anything is claimed, a run asks you, with no delegate option:

- **The run scope**: one map, the whiteboard, or everything, each with its frontier count. When you pick one map, it then asks which (skipped when only one map is open; the active map is recommended). `/trailhead:auto <n>` runs map `n` and skips only this ask.
- **Parallel slots**: 1, 2, 3 or 4 tickets in flight at once, with 2 proposed. Asked under `<n>` too.
- **External review rounds**: as configured, 1, 2, 3 or until convergence (it stops on a round with no progress, hard ceiling 5). The structured menu shows at most four options; a host without one gets the full five as a numbered list. The ask is skipped when plan review is off or no independent reviewer CLI is installed (the host's own CLI does not count). Config warnings are printed first, and a helper error before any claim hands the run back. Your choice holds for every `build` ticket of the run and overrides `plan_review.rounds` for that run.

### Order

Under everything the run works one map at a time by ascending map number, the whiteboard last. Inside a scope it takes the oldest workable ticket first (lowest number). Blocked tickets are never queued, and tickets marked needs-you are skipped. Interrupted (paused) tickets you own in the scope are resumed first.

### Parallel slots

With 1 slot, `isolation: auto` and `none` work in the current checkout; an explicit `worktree` or `clone` still applies, and its push or PR is held for you. Above 1 slot, each ticket gets its own `trailhead/t<n>` workspace next to the checkout (`<repo>-t<n>`): a worktree whatever `isolation:` says, an explicit `clone` stays a clone, and a superrepo (submodules) escalates to a clone.

The run stays one orchestrating session, and every engine step runs as a background agent for its slot. When a slot frees, it takes the next oldest ticket, so tickets of different maps can run together.

### Merging locally

Under `git: main`, a verified worktree slot branch is merged into the local trunk (fast-forward, else a merge commit), never pushed, one at a time after the stale-base check. Then the ticket is resolved and its dependents unblocked.

A sequential run under an explicit `worktree` or `clone`, a run under `git: pr`, and clone slots hold the branch instead: the ticket is marked needs-you for integration, with its branch and workspace kept and listed.

### Merge tickets

When a slot branch conflicts, the merge is aborted and the trunk stays untouched. The branch stays separate with its workspace, and the run opens or updates one **merge ticket** per map (or for the whiteboard), the moment the conflict arises. It is a needs-you task listing each unmerged branch with its ticket, workspace and conflicting files, plus a suggested merge order (oldest first). You close it once every branch is merged or dropped. A scope with no unmerged branch gets none, and held branches open none. The conflicting ticket stays open, so its dependents stay blocked.

### Acceptance and UAT follow-ups

The run drives the agent-performable acceptance steps itself. It never picks skip and never fakes a human-only step. Human-only steps go to a **UAT follow-up** carrying the numbered checklist: an open one is reused, otherwise it opens a task on the same map or the whiteboard (or a seed when the steps wait on an external trigger). Then the parent ticket resolves and its dependents unblock. Only the configured `uat.setup` runs; a failing setup marks the ticket needs-you.

### What it parks for you

A ticket whose next step needs you is parked at once and the run continues:

- a `decision` convergence, a destination or scope change, an out-of-scope ruling, routing a deferred line, closing an exhausted map, a claim collision, or fog to dissolve;
- a HITL `task` whose checklist only you can do;
- a safety-rail action, a stale-base stop, a failing UAT setup, or an error while looking up the UAT follow-up;
- a plan review whose blocking concerns survive the rounds (quoted in full).

Parking leaves a `NEEDS YOU` comment saying what you must do, unassigns the run and adds the `trailhead:needs-you` label. The ticket stays on your frontier and map, and `/trailhead:work` still offers it, but runs skip it until you clear it (a `work` or `quick` claim clears it, or remove the label by hand). The map panel shows these tickets in a `Needs you` group at the top.

The **safety rail** (always on, hardcoded) covers a release, `git push`, opening a PR, a delete or force, and any other outward-facing action: the ticket is marked needs-you and the run continues. Local commits and the local slot merge are not rail actions.

A ticket that will not verify gets a bounded **failure budget** (a no-progress rule plus a hardcoded ceiling of 3 extra rounds); at exhaustion the run pauses that ticket, keeping its claim, and skips it. One stuck ticket never ends the run.

### Records, interruption and resume

Every record is written on the tracker when it arises (engine comments, commits, UAT follow-ups, `NEEDS YOU` comments, merge tickets, `PAUSED` checkpoints), so a crash loses nothing. The chat progress line, which names the tickets in the slots, is only a mirror.

**Interruption** is just the host interrupt (Stop/Esc), the only mid-run halt: it writes nothing, so every in-flight ticket (each slot's) keeps its claim and Esc leaves the same trace as a crash. **Resume** is you running `/trailhead:auto` again: it first recovers an interrupted merge, then resumes paused or crashed tickets in their own workspaces, writing the missing `PAUSED` checkpoint (naming workspace and branch) on each crashed one as it resumes it, then continues. In the same session it reuses the run's choices; a new session asks again. Needs-you tickets are not reconsidered.

### The run report

Every run ends with one summary, in full in chat, linking the records it summarises:

- why it stopped;
- what resolved;
- what merged: merged tickets, branches left unmerged with their conflicting files, the merge tickets, and how many commits the local trunk is ahead of `origin` (pushing is yours);
- what remains: needs-you tickets and why, paused or stuck tickets, blocked dependents, and UAT follow-ups opened.

It is also posted as a comment on each touched map, with only that map's part. The whiteboard part stays in chat only, and untouched maps get nothing.

`auto` is **orthogonal to `effort` and `models.*`**: it changes neither, and it has no config surface of its own (the asks above replace it).

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
- **④ prototype** → a rough login screen (on the configured [design surface](/docs/design)), approved before UI code.
- With ②③④ closed, **⑤ build** graduates → discuss → plan → execute (atomic commits, TDD at the auth seams) → verify (tests + code review + [acceptance](/docs/acceptance-testing): asked who drives, the agent goes AI-driven and drives the browser through the real login flow).
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
