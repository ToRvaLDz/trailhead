---
title: "Work commands"
description: "work, quick, pause, resume, split, and auto: the verbs that resolve tickets and manage a ticket's lifecycle."
---

The work verbs resolve tickets and manage a ticket's lifecycle. A ticket is resolved by the engine for its type (decision, research, prototype, build, bug, task); see [Workflow](/docs/workflow) and [Ticket types](/docs/ticket-types). Back to the [command index](/docs/commands).

### /trailhead:work

Work the next frontier ticket, or the one you name.

**Syntax**

```
/trailhead:work [ticket]
```

**Arguments**

- `ticket` (optional): a ticket number. It may be a whiteboard ticket, which is then worked whole, off the map, with splitting allowed. Without it, trailhead takes a frontier ticket of the active map (never a whiteboard ticket).

**What it does**

1. For a named ticket, first checks that it is open. A closed, superseded, out-of-scope or nonexistent number stops right there, before any setup, and trailhead suggests the next step (for a defect in closed work, a new `bug`).
2. Picks the map (the one you named, else the active map; if several are open and none is active, it asks) and, when several independent tickets sit on the frontier, offers them as a set to choose from rather than crowning one.
3. Claims the ticket by assigning it to you. On a claim collision it stops and asks.
4. Resolves isolation. Under the default `isolation: auto` it asks whether you will work more than one ticket at once on this machine (your answer is remembered for the working stretch, and the ask is skipped when the session is already inside the ticket's own worktree); yes gives a `git worktree` (or a `clone` for a submodule repo), no keeps the current checkout. An explicit `none`, `worktree` or `clone` is honoured as set.
5. Writes the session-ticket marker and syncs the commit-msg hook (see [Hooks](/docs/hooks#commit-msg-hook)).
6. Briefs you on what resolving the ticket will do and asks whether to change anything. A change consistent with the ticket is folded in; a divergent one is offered as work-as-is or a separate new ticket, never forced. The menu is skipped, replaced by a one-line note ("working X (#n), scope as just agreed"), when this same session just shaped the ticket: it created it from your own request (`todo`, `bug`, `idea`, `seed`, `ticket`, `quick` text, or an approved split child) or concluded a `grill <ticket>` on it. Tickets created in bulk (`new`, `adopt`, `inbox`) still get the menu.
7. Runs the engine for the ticket's type. For build and bug tickets that is Discuss, Plan, Execute, Verify, Resolve, with a grilling round only if you agree to one.
8. Records the resolution, closes the ticket, unblocks dependents, adds newly surfaced tickets, and hands off with a `/clear`-first next-step block.

**What it writes**

- The claim (assignee) on the ticket; engine comments (`DISCUSS`, `PLAN`, `VERIFY`, the resolution, and for bugs `REPRO` and `DIAGNOSIS`); atomic commits, each with a `Refs: #<n>` trailer.
- The closed ticket, the map's Decisions so far, removed `trailhead:blocked` labels on newly unblocked dependents, and any new tickets or graduated fog.
- Local, gitignored markers: `.trailhead/session-ticket` and `.trailhead/active-map`.
- When a map is exhausted it asks about any deferred out-of-scope lines and whether to close the map, and refreshes the dashboard.

**Example**

```
/trailhead:work 42
```

trailhead confirms #42 is open, claims it, summarises the plan of attack, and waits for your go before running the engine.

### /trailhead:quick

Work one ticket whole, never splitting.

**Syntax**

```
/trailhead:quick [ticket | "text"]
```

**Arguments**

- `"text"`: opens a new whiteboard ticket (a `build`, or a `bug` when the text is clearly a defect) and works it now.
- `ticket`: an existing ticket number, worked the same way where it already lives; a map ticket stays on its map.
- Neither: trailhead asks which piece to work.

**What it does**

1. For a number, checks the ticket is open (same early stop as `work`). For text, opens the whiteboard ticket with a one-line confirmation.
2. Claims it and sets up isolation and the commit-msg hook exactly as `work` does.
3. Size-triages at the start, every time, whatever `effort` is set to. On a trivial or small change it offers one consolidated option to skip the heavy steps (plan pass, TDD, cross-AI review, full code review, goal-backward verify) and goes lean only on an explicit yes. The correctness spine always stays.
4. Runs the full cycle: grills only if a blocking ambiguity surfaces, and never splits, however big the ticket turns out. New scope that surfaces is captured out, not folded in.
5. Resolves, closes, and hands off. For a new whiteboard ticket the dashboard refreshes at the handoff.

**What it writes**

- A `trailhead:whiteboard` ticket (for text), the claim, engine comments, atomic `Refs: #<n>` commits, the resolution and the close.
- No map book-keeping (no Decisions so far, fog, or frontier re-scan). On a map ticket, dependents are still unblocked.
- The dashboard, regenerated at the handoff for a new whiteboard ticket (or at `pause` if the session stops first).

**Example**

```
/trailhead:quick "make the footer links open in a new tab"
```

trailhead opens a whiteboard ticket, offers to skip the heavy steps because the change is small, and on your yes plans, commits and verifies in one sitting.

### /trailhead:pause

Checkpoint the ticket in play so anyone can resume it.

**Syntax**

```
/trailhead:pause [note]
```

**Arguments**

- `note` (optional): anything the next session should know.

**What it does**

1. Commits any work in progress as atomic commits so nothing is stranded.
2. Posts a `PAUSED` checkpoint: what is done, the exact next step, and local state (branch, the worktree or clone path under isolation, how to run it), then adds the `trailhead:paused` label so the ticket shows under `Paused` on every surface (panel, map, whiteboard, dashboard). A paused ticket is off the frontier until resumed: bare `/trailhead:work` never picks it, `/trailhead:resume` (or an explicit `work <n>` / `quick <n>`) takes it back.
3. Keeps your claim if you will return soon, or releases it (unassigns) if the pause is open-ended so someone else can take over.
4. Refreshes the dashboard if the paused ticket is a whiteboard quick whose refresh was still deferred.

**What it writes**

- A `PAUSED` comment on the ticket and the work-in-progress commits.
- If you release the claim, the assignment is removed and `.trailhead/session-ticket` is cleared.

**Example**

```
/trailhead:pause waiting on the API key from ops
```

trailhead commits what exists, posts the checkpoint with your note, and asks whether to keep or release the claim.

### /trailhead:resume

Resume a paused ticket from its checkpoint.

**Syntax**

```
/trailhead:resume [ticket]
```

**Arguments**

- `ticket` (optional): the ticket number to resume.

**What it does**

1. Reads the ticket's latest `PAUSED` checkpoint and the `DISCUSS` and `PLAN` comments above it.
2. Picks up at the recorded next step. A released ticket can be resumed by anyone; a still-claimed one only by its owner. Once the claim is confirmed it removes the `trailhead:paused` label (a refused resume leaves the ticket paused); a `work` or `quick` claim of a paused ticket drops it too.
3. Under `worktree` or `clone` isolation, re-enters the workspace recorded in the checkpoint.

**What it writes**

- The `.trailhead/session-ticket` marker, re-written at the working root so tooling such as the statusline shows the ticket again.
- Whatever the resumed engine step writes (comments, commits).

**Example**

```
/trailhead:resume 42
```

trailhead reads the checkpoint on #42, tells you where it left off, and continues from the recorded next step.

### /trailhead:split

Split an oversized ticket into children and supersede the original.

**Syntax**

```
/trailhead:split [ticket]
```

**Arguments**

- `ticket` (optional): the ticket to split; defaults to the one in play.

**What it does**

1. Proposes the children it would create (each with its title and why it is a distinct session-sized piece) and how the original's blockers would be re-pointed. It creates nothing until you say go; even an explicit `/trailhead:split` is not a go-ahead on how.
2. Creates the children, wiring blockers between them at the sibling's real ticket number.
3. Supersedes the original with a comment listing the children, then closes it.

**What it writes**

- Child tickets with `Parent:`, `Split from:`, a type label, the map label and sub-issue edge, and `trailhead:blocked` where needed.
- On the original: a `split into ...` comment, the `trailhead:superseded` label, its sub-issue edge dropped (reclaiming a slot), then closed. It stays out of Decisions so far; its children replace it.
- Re-pointed `## Blocked by` lines on tickets that waited on the original.

**Example**

```
/trailhead:split 42
```

trailhead proposes three children (schema, API, UI) with the blocking between them, and creates them after you confirm.

### /trailhead:auto

Run a chosen scope autonomously until a stop condition or exhaustion, in up to 4 parallel slots.

**Syntax**

```
/trailhead:auto [map]
```

**Arguments**

- `map` (optional): the map to run, without the scope ask. A closed or non-map number is reported, not run. Without it, trailhead asks once for the run scope: one map, the whiteboard, or everything, each with its frontier count (then which map, when you pick one map and several are open). The slot count and the external review rounds are still asked.

**What it does**

1. Asks, before claiming anything and with no delegate option: the run scope (unless `map` is given), the parallel slots (1, 2, 3 or 4, with 2 proposed), and the external review rounds (as configured, 1, 2, 3 or until convergence; skipped when plan review is off or no independent reviewer CLI is installed). The review choice holds for every `build` ticket of the run and overrides `plan_review.rounds` for it.
2. Recovers an interrupted merge, then resumes first any of your paused or crashed tickets in the scope, each in its own workspace.
3. Loops over the scope: claims the oldest workable ticket (`build`, `bug`, an AFK `task`, an AFK `research`), resolves it with its normal configured cycle, unblocks dependents, and takes the next one into any free slot, until nothing auto-workable is left. Under everything it works one map at a time by ascending map number, the whiteboard last. Blocked tickets are never queued. This suspends the one-ticket-per-session rule; there is no cap on tickets, time or tokens.
4. With 1 slot, `isolation: auto` and `none` work in the current checkout. Above 1 slot each ticket gets its own `trailhead/t<n>` workspace next to the checkout: a worktree whatever `isolation:` says, an explicit `clone` stays a clone, and a superrepo escalates to a clone.
5. Under `git: main`, merges each verified worktree slot branch into the local trunk (fast-forward, else a merge commit), never pushed, one at a time after the stale-base check, then resolves the ticket and unblocks its dependents. Under `git: pr`, for clone slots, and for an explicit `worktree` or `clone` in a sequential run, the branch is held: the ticket is marked needs-you for integration, with its branch and workspace kept and listed.
6. When a slot branch conflicts, aborts the merge (the trunk is untouched), keeps the branch and its workspace, and opens or updates one merge ticket per map (or for the whiteboard) listing each unmerged branch with its ticket, workspace, conflicting files and a suggested merge order. The conflicting ticket stays open, so its dependents stay blocked.
7. Drives the agent-performable acceptance steps itself and never picks skip. Human-only steps go to a UAT follow-up (reused if one is open, else opened) carrying the numbered checklist, then the parent resolves. Only the configured `uat.setup` runs.
8. Takes advisory choices as the delegate option without the confirm gate. Anything that needs you is parked at once and the run continues: decision convergences, scope or destination changes, out-of-scope rulings, fog, HITL tasks with human-only steps, a stale-base stop, a failing UAT setup, and a plan review whose blocking concerns survive the rounds.
9. Never performs a release, `git push`, PR, delete or force, or any outward-facing action: that ticket is marked needs-you. Local commits and the local slot merge are not rail actions.
10. On a ticket that will not verify it extends past the normal fix rounds (no-progress rule, plus up to 3 extra rounds), then pauses the stuck ticket with its claim and moves on.
11. Prints a live progress line naming the tickets in the slots. Esc or Stop interrupts safely: every in-flight ticket keeps its claim with a `PAUSED` checkpoint naming its workspace and branch. Run `/trailhead:auto` again to resume.

A parked ticket gets a `NEEDS YOU` comment saying what you must do, is unassigned, and carries the `trailhead:needs-you` label. It stays on your frontier and map and `/trailhead:work` still offers it, but runs skip it until you clear it (a `work` or `quick` claim clears it, or remove the label by hand).

**What it writes**

- Everything the per-ticket engine writes (comments, `Refs: #<n>` commits, closes, unblocks), on the tracker as each record arises.
- UAT follow-ups, `NEEDS YOU` comments with the `trailhead:needs-you` label, and merge tickets.
- Local merge commits on the trunk (`chore(auto): merge trailhead/t<n>`), never pushed.
- A run report, in full in chat and as a comment on each touched map with only its own part: why it stopped, what resolved, what merged (branches left unmerged with their conflicting files, merge tickets, how far the local trunk is ahead of `origin`), and what remains (needs-you tickets and why, paused or stuck tickets, still-blocked dependents, UAT follow-ups opened). The whiteboard part stays in chat only.

**Example**

```
/trailhead:auto
```

trailhead asks for the scope, the slots and the review rounds, then works tickets in the slots, printing a line as they advance, and ends with a report of what it resolved, what merged, and what it parked for you. Run it again to drain more.

Next: [view commands](/docs/commands/view) to see where the map stands.
