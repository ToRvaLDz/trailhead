# The autonomous run: `auto`

`auto` runs a map's **frontier autonomously**, ticket by ticket, until a stop condition fires or the frontier is exhausted. It is the one verb that **suspends the one-ticket-per-session rule**: while engaged it chains `build` / `bug` / `task` tickets in a single run. It is invoked explicitly, per run, as `/trailhead:auto [map]`; it **never re-engages on its own**. The run itself is an **autonomous run** (the noun); `auto` is the verb. Everything else about the engine (the substrate, the per-type engines, claiming, the session handoff) is unchanged: `auto` orchestrates the existing cycle, it does not replace it.

Load the same shared core the cluster loads (`../../_shared/principles.md`, `substrate.md`, `session-handoff.md`, `configuration.md`, `techniques.md`, `ticket-language.md`), then this file.

## Preconditions and engagement
1. **Pick the map** exactly as bare `work` does: the map named in the argument, else the active map (`.trailhead/active-map`); if neither and more than one is open, list them and ask.
2. **Resume an interrupted ticket first.** Before scanning the frontier, check for a ticket **you own** (assigned to you) on this map that is in a `PAUSED` state from a prior interrupted run. If one exists, pick it back up via the **`resume`** engine (`../../_shared/teamwork.md`) and carry it to resolution first, then continue into the loop below. This is how an interrupted run is continued: the human re-invokes `/trailhead:auto`, and auto resumes the in-flight ticket before taking anything new.
3. **Load config once** from the map's project root, as every session does. `auto` reads no config of its own (there is none, per the decisions).

## The safety rail (always on, checked FIRST)
Independent of and **above** the advisory boundary below, `auto` **never performs an irreversible or outward-facing action without an explicit human go-ahead**. Before any automatic choice handling, check the rail. The rail stops on:
- cutting a **release**;
- `git push`;
- **opening a PR**;
- a **delete / force** (`git push --force`, `rm -rf` of tracked work, a force-delete of a branch or remote ref);
- any other **outward-facing** action (posting outside the tracker, calling an external service that mutates state).

When the next step of a ticket would trip the rail, auto **sets that ticket aside and continues** (it does not perform the action and does not block the whole run): it hands the outward action back to the human, recorded in the run-end summary. **Atomic local commits to `main` are not rail-tripping**: they are the normal Execute and continue automatically. The rail is **hardcoded**, not a disableable toggle.

## The advisory boundary (the `choices.md` one-line test, no confirm gate)
Wherever the engine would put a **forced choice** to the human, apply the one-line test in `../../_shared/choices.md`:
- **Advisory / process choice** (the test's Positive side: the delegate option is offered): `auto` **takes the delegate option WITHOUT its confirm gate**. It picks the best option with the same honest rationale delegate would state, and proceeds. This is the whole of auto's autonomy: "take delegate, skip the confirm." No new confidence threshold, no separate allowlist, so the boundary can never drift from the tested convention.
- **Human-necessary decision** (the test's Negative side: delegate is withheld): a `decision`-ticket convergence, a destination or scope change, an out-of-scope ruling, routing a deferred line to seed/idea/todo, closing an exhausted map, a claim collision. `auto` **sets that ticket aside and continues** (it does not decide). Likewise **fog** that needs dissolving into tickets (a human grilling act) is set aside.

## The run loop (a fixpoint, not one pass)
Repeat until a full scan finds nothing auto-workable left:
1. **Scan the frontier** for this map (the normal frontier query, scoped to the map). Skip any ticket whose immediate next step is a human-necessary decision, fog, or a rail action (those are set aside for the human).
2. **Take the next auto-workable ticket**, claim it, and resolve it with its type's engine in `ticket-engines.md` (`build`/`bug`/`task` chain automatically; a `decision`/`prototype` that needs the human is set aside). The per-ticket engine runs its **normal configured cycle** (TDD, Code review, Goal-backward verification per config): auto is **orthogonal to `effort` and `models.*`** and changes neither. The run loop is orchestrated by the session model.
3. **On resolution**, do the normal Resolve book-keeping, then **unblock dependents** (remove `trailhead:blocked` from any dependent whose last blocker just closed) and **re-scan**. A ticket that graduates onto the frontier this way is picked up in a later pass: this is why the loop is a fixpoint, not a single sweep.
4. **Emit a live chat progress line** as the run advances (below).

The run ends only when a full scan finds **nothing auto-workable** (the auto-workable frontier is exhausted), or on **human interrupt** (below). There is **no cap** on tickets, wall-clock, or tokens: a human wall never ends the run, it only shrinks the auto-workable set (auto **drains** rather than halts).

## Per-ticket failure budget (a ticket that will not verify)
On the green path a ticket resolves and the loop continues. On a **Verify failure**, auto does not hand back at the would-be checkpoint. Instead it **extends past the engine's normal bounded fix-and-re-review rounds**, taking the advisory "which fix" sub-choice as **delegate** (the accept / resolve-anyway decision still stays the human's, so at true exhaustion it does not silently resolve a red ticket). The per-ticket **failure budget** is: a **no-progress rule** (stop iterating once a round makes no measurable progress) **plus a hardcoded ceiling of 3 extra rounds** (tunable only in code; there is no config surface). At budget exhaustion, still red, auto **pauses the stuck ticket keeping its claim** (a `PAUSED` checkpoint) and **skips to the next frontier ticket** (skip-and-continue, not stop-the-run). A single stuck ticket never ends the run; its dependents stay blocked naturally. Skipped / stuck tickets are reported at run end. The accepted cost is stranded dependents and accumulated paused tickets.

## Reporting, interruption, resume
- **In-run reporting = both.** The per-ticket engine comments (`DISCUSS`/`PLAN`/`VERIFY`/resolution, etc.) land on the Issues **as usual**, and auto **also emits a live chat progress line** as it advances (e.g. which ticket it just resolved and what it is taking next), so the human can watch a run without reading the tracker.
- **Interruption = the host interrupt (Stop/Esc), the only mid-run halt.** There is no separate "stop after this ticket". Atomic commits plus ticket-boundary checkpoints make interruption **safe by construction**: on interrupt the in-flight ticket **keeps its claim and gets a `PAUSED` checkpoint** (per `../../_shared/teamwork.md`), cleanly resumable.
- **Resume = the human re-invokes.** `auto` never resumes on its own. The human runs `/trailhead:auto` again; engagement step 2 above picks the interrupted ticket back up via `/trailhead:resume` before scanning, and the run's earlier set-aside (human-necessary) and paused/stuck tickets are back on the frontier for this fresh run to reconsider.

## Run-end summary (every terminus)
Whatever ends the run (frontier drained or human interrupt), auto emits **one run-end summary**, in **two places**: a **chat block** for the human, and the **same summary posted as a comment on the map issue** (the durable tracker record). The summary states:
- **why it stopped** (auto-workable frontier exhausted, or human interrupt);
- **what resolved** (the tickets auto closed this run);
- **what remains**: the **set-aside human-necessary** tickets (fog, `decision` convergences, out-of-scope rulings, rail actions) and **why each needs the human**, the **paused / stuck** tickets from the failure budget, and any **blocked dependents** still waiting.

Then hand back to the human with the normal session handoff framing (`../../_shared/session-handoff.md`): the human decides what to take next (dissolve fog, make a held decision, authorise a rail action, then re-invoke `/trailhead:auto` to drain more).
