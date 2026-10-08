---
title: "Work commands"
description: "work, quick, pause, resume, split, and auto: the verbs that resolve tickets and manage a ticket's lifecycle."
---

The work verbs resolve tickets and manage a ticket's lifecycle. A ticket is resolved by the engine for its type (decision, research, prototype, build, bug, task); see [Workflow](/docs/workflow) and [Ticket types](/docs/ticket-types). Back to the [command index](/docs/commands).

<h3 id="work">/trailhead:work</h3>

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
4. Resolves isolation. Under the default `isolation: auto` it asks once whether you will work more than one ticket at once on this machine; yes gives a `git worktree` (or a `clone` for a submodule repo), no keeps the current checkout. An explicit `none`, `worktree` or `clone` is honoured as set.
5. Writes the session-ticket marker and syncs the commit-msg hook (see [Hooks](/docs/hooks#commit-msg-hook)).
6. Briefs you on what resolving the ticket will do and asks whether to change anything. A change consistent with the ticket is folded in; a divergent one is offered as work-as-is or a separate new ticket, never forced.
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

<h3 id="quick">/trailhead:quick</h3>

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

<h3 id="pause">/trailhead:pause</h3>

Checkpoint the ticket in play so anyone can resume it.

**Syntax**

```
/trailhead:pause [note]
```

**Arguments**

- `note` (optional): anything the next session should know.

**What it does**

1. Commits any work in progress as atomic commits so nothing is stranded.
2. Posts a `PAUSED` checkpoint: what is done, the exact next step, and local state (branch, the worktree or clone path under isolation, how to run it).
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

<h3 id="resume">/trailhead:resume</h3>

Resume a paused ticket from its checkpoint.

**Syntax**

```
/trailhead:resume [ticket]
```

**Arguments**

- `ticket` (optional): the ticket number to resume.

**What it does**

1. Reads the ticket's latest `PAUSED` checkpoint and the `DISCUSS` and `PLAN` comments above it.
2. Picks up at the recorded next step. A released ticket can be resumed by anyone; a still-claimed one only by its owner.
3. Under `worktree` or `clone` isolation, re-enters the workspace recorded in the checkpoint.

**What it writes**

- The `.trailhead/session-ticket` marker, re-written at the working root so tooling such as the statusline shows the ticket again.
- Whatever the resumed engine step writes (comments, commits).

**Example**

```
/trailhead:resume 42
```

trailhead reads the checkpoint on #42, tells you where it left off, and continues from the recorded next step.

<h3 id="split">/trailhead:split</h3>

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

<h3 id="auto">/trailhead:auto</h3>

Run the frontier autonomously until a stop condition or exhaustion.

**Syntax**

```
/trailhead:auto [map]
```

**Arguments**

- `map` (optional): the map to run. Without it, the active map; if there is none and several are open, trailhead asks.

**What it does**

1. Resumes first any of your tickets left in a `PAUSED` state by an interrupted run.
2. Loops over the frontier: claims an auto-workable ticket (`build`, `bug`, an AFK `task`, an AFK `research`), resolves it with its normal configured cycle, unblocks dependents, and rescans until nothing auto-workable is left. This suspends the one-ticket-per-session rule; there is no cap on tickets, time or tokens.
3. Takes advisory choices as the delegate option without the confirm gate. Human-necessary items are set aside, not decided: decision convergences, scope or destination changes, out-of-scope rulings, fog that needs dissolving, HITL tasks with human-only steps, and a claim collision.
4. Never performs a release, `git push`, PR, delete or force, or any outward-facing action. It sets that step aside for you. Under `git: pr` this means each ticket is finished locally and its push and PR are left for you, so a run drains less per invocation than under `git: main`.
5. On a ticket that will not verify it extends past the normal fix rounds (no-progress rule, plus up to 3 extra rounds), then pauses the stuck ticket with its claim and moves on.
6. Prints a live progress line per ticket. Esc or Stop interrupts safely: the in-flight ticket keeps its claim with a `PAUSED` checkpoint.

**What it writes**

- Everything the per-ticket engine writes (comments, `Refs: #<n>` commits, closes, unblocks).
- A run-end summary, both in chat and as a comment on the map: why it stopped, what resolved, and what remains (set-aside tickets and why, paused or stuck tickets, ready-to-integrate branches, still-blocked dependents).
- Under `isolation: auto` it resolves to the current checkout without asking.

**Example**

```
/trailhead:auto
```

trailhead works frontier tickets one after another, printing a line per resolved ticket, and ends with a summary of what it set aside for you. Run it again to drain more.

Next: [view commands](/docs/commands/view) to see where the map stands.
