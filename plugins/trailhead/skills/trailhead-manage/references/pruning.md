# Pruning a map's sub-issue edges

`/trailhead:prune [map]` reclaims native sub-issue slots on a map that is near or at **GitHub's hard cap of 100 native sub-issues per issue**, so new tickets can keep attaching to the map's visual sub-issue tree. It never loses anything from the record: it drops only the **native edge**, and every reference stays (the ticket's `Parent:` line, the map's `Decisions so far` pointer, and the `trailhead:map-<n>` label).

**Why this is safe.** The frontier is computed from the `trailhead:map-<n>` **label**, never from the native edge (see `../../_shared/substrate.md`). So the native sub-issue edge is purely GitHub's visual rendering: dropping the edge of a closed ticket, or of an open ticket that no longer belongs to this map, changes nothing in engine behaviour (selection, blocking, resolution). Only GitHub's sub-issue tree and progress bar are affected, and a dropped edge can always be re-added later.

## 1. Resolve the target map

The argument is the map (number or URL). With no argument, use the active map (`.trailhead/active-map`); if there is no active map and more than one `trailhead:map` is open, list them and ask which. Set/refresh `.trailhead/active-map` to the map being pruned (see **Multiple maps on one repo** in `../../_shared/multi-map.md`).

## 2. Read the count and list the edges

Read the map's native sub-issue count (one cheap field), then list every native sub-issue of the map, **paginated** (never a single page), capturing each one's number, id, and state. The exact `gh` commands are in `../../_shared/substrate-commands.md` (section "Sub-issue cap and pruning"); this protocol only says how to use them.

## 3. Classify each edge (bidirectional reconcile)

Classify every edge by its target, so the pass converges the map's edges to exactly "its open, still-labelled tickets":
- **Target is CLOSED** -> **remove** the edge (reclaim the slot; references kept). This is the common case: resolved and superseded tickets.
- **Target is OPEN and still carries `trailhead:map-<n>` for this map** -> **keep** the edge.
- **Target is OPEN but does NOT carry `trailhead:map-<n>` for this map** (an orphan: a ticket that no longer belongs to this map) -> **remove** the edge. It does not belong here; its own map, if any, holds its own edge. Confirm the label is genuinely absent before removing (read the ticket's labels), so a ticket that is legitimately mid-wiring is never stripped.

Also compute the **missing** set: open tickets that **do** carry `trailhead:map-<n>` for this map but have **no** edge in the list above (re-derived by diffing, so no stored state is needed).

## 4. Preview and confirm (never mutate silently)

Show a preview and wait for an explicit go-ahead before any change:
- edges to **remove**: how many closed, how many orphan-open, and the resulting `total` (X -> Y);
- edges to **add**: how many missing edges for open labelled tickets, and how many will fit under the cap after the removals.

This choice is advisory (a process choice): offer the delegate option per `../../_shared/choices.md`. On anything but an explicit yes, stop and change nothing.

## 5. Apply

Remove each classified-for-removal edge with the DELETE from `../../_shared/substrate-commands.md` (section "Sub-issue cap and pruning"), passing the edge's internal `id` captured in step 2. Then **re-read** `sub_issues_summary.total` (do not trust the pre-removal count) and add the missing edges up to the remaining capacity (100 - current total), each independently, with the re-add POST from that same section. The missing set came from a label diff, so it holds issue *numbers*, not internal ids: resolve each missing ticket's internal id first (the POST snippet in the cookbook shows the `$(gh api .../<ticket> --jq .id)` substitution).

Because each id came from step 2's listing, a 404 here means the edge is no longer native (a detach that raced this run, for example a concurrent prune): the slot is already free, so count it toward the reconciled/removed result and keep going, per the 404-tolerance documented in the cookbook. That is distinct from a genuine failure.

Report **per edge**: each removal and each add, success or failure. A single edge failing (for example a concurrent creation consuming the last slot) is never fatal: record it and continue.

## 6. Report

Say plainly what happened: slots reclaimed (closed + orphan removed), edges re-added, and the new `total` against 100. An already-detached edge caught as a 404 is a clean no-op, not a failed edge; keep it out of any failure count, distinct from a genuine edge failure (a transient API error or a permissions error), which is what "record it and continue" covers. If open labelled tickets still lack an edge because capacity ran out, **list them** and note that a later `/trailhead:prune` (once more tickets close) will attach them. Never close, reopen, relabel, or otherwise touch any ticket: prune only ever adds or removes the map's native sub-issue edges.

## Notes

- Prune touches **only this map's** native edges; it never mutates another map's tree, and never a ticket's body, labels, or state.
- The dashboard flags a map `near cap · <total>/100` (total >= 90) or `at cap` (total >= 100), appending `· prunable` when the map has closed edges to reclaim, and offers `/trailhead:prune`; it never auto-prunes (see the dashboard render in `../../trailhead-view/SKILL.md`).
- At edge-add time the engine pre-checks the cap and offers prune instead of silently dropping the edge (see the child->map procedure in `../../_shared/substrate-commands.md`).
