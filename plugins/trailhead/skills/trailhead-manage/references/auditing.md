# Auditing closed work and open overlap

`/trailhead:audit [map] [--all]` answers two questions about a repo's tickets: did the closed ones actually deliver what they promised, and are any open ones duplicates or small enough to land together? It is **read-only until you confirm**: the verification and the comparison only read, the result is one consolidated report, and every change that follows is a separate proposal applied only on an explicit yes. Nothing is written to GitHub before that.

All `gh` mechanics are in `../../_shared/substrate-commands.md`; this protocol only says how to use them. Only the purely process choices (the >20 cost-guard ask, the re-run offer for unverifiable tickets) are advisory, so offer the delegate option on those per `../../_shared/choices.md`. The reopen, duplicate-close and merge proposals reshape the map, so they are **human-owned**: do not offer the delegate option on them. The marker advance stays an explicit yes too.

## 1. Scope

- **No argument** (a whole-repo run): the **open-ticket pass** (step 7) covers every open `trailhead:map` plus the whiteboard (the loose, map-less tickets). The **closed-ticket window** (step 2) is wider: every `trailhead:ticket` closed in the window repo-wide, under any map (open or closed, so a map exhausted and closed between audits is still audited) plus the whiteboard, minus the skip list.
- **`[map]`** (number or URL): that map's tickets only, meaning the tickets carrying its `trailhead:map-<n>` label, for both the closed and the open pass.

`--all` widens the **window** (below), never the scope; it combines with a map.

## 2. The window and the cutoff

Capture the **cutoff** first, before any listing: the current time, ISO-8601 UTC. Everything this run decides is relative to that one instant.

Read the last-audit marker from the pinned dashboard body: a hidden line `<!-- trailhead:last-audit <ISO-8601 UTC> -->` (see Body generation in `../../_shared/substrate-commands.md`, which preserves it through every regeneration).

- **Default set**: closed tickets in scope (repo-wide for a whole-repo run, see step 1) with `marker < closedAt <= cutoff`. Narrow with a coarse `closed:>=<marker date>` search, then filter exactly and locally on each ticket's `closedAt`.
- **No marker, or `--all`**: every closed ticket in scope (repo-wide for a whole-repo run), up to the cutoff.

**Skip only what delivered nothing by design**: `trailhead:superseded`, `trailhead:out-of-scope`, and tickets closed with GitHub's native duplicate state reason (read it through GraphQL or `gh --json stateReason`, which gives `DUPLICATE`, or through REST `state_reason`, which gives `duplicate`; the audit's own duplicate close below sets it). Every other closed ticket is verified, **type-aware**:

- `build` / `bug`: against the code.
- `decision` / `research`: against their recorded answer (a resolution comment that answers the Question and, where that answer committed the code to something, that the code honours it).
- `prototype` / `task`: against their recorded outcome (the linked artifact, or the stated resulting facts).

## 3. Enumerate exhaustively

Every listing the audit relies on (the closed set, the open set, blockers, dependents) must be **complete**, never `gh issue list`'s default page. Use `gh api --paginate` (search or issues endpoints, `per_page=100`), or the native `blocked_by` / `blocking` endpoints with `--paginate`. The search API caps at 1000 results and `--paginate` stops there silently, so for every search compare the response `total_count` with the number of items fetched and check `incomplete_results`. If `total_count` exceeds 1000 or `incomplete_results` is true, **split the window by date ranges** (bisect the `closed:` range) until each slice is complete, then merge the slices. If a slice cannot be made complete, or any listing errors or comes back truncated, **stop and report it**, and never propose a marker advance from an incomplete run.

## 4. Cost guard

Count the set to verify. When it **exceeds 20** tickets, show the count and ask whether to proceed, narrow to one map, or cancel. At 20 or fewer, go straight on.

## 5. Verify the closed set

Dispatch each ticket to a **`trailhead-verify`** agent (see `../../_shared/techniques.md` for dispatch, the `config.models.verify` model override, and the inline fallback), in parallel **batches of 5**, background and polled: reviews never block the session. The verification protocol is `../../_shared/techniques/verify.md`; this audit states its own brief on top of it, and `verify.md` itself is unchanged.

**Audit-mode brief**, handed to each agent:
- Work goal-backward against the **current HEAD code** and the ticket's own Question / Outcome / PLAN criteria.
- Use the ticket's `Refs: #<n>` commits as evidence when present. For the audit, this brief **overrides two rules of `techniques/verify.md`**: an **empty Refs set is evidence, not an error** (old or manually closed tickets carry none, so verify against HEAD and the recorded answer or outcome instead), and the agent **posts nothing** (it returns its verdict to the caller, never a `VERIFY` comment).
- Return a result **per claim** (met / unmet / inconclusive, each inconclusive with its reason) **plus whether the type's deliverable is present**: code for `build` / `bug`, a recorded answer for `decision` / `research`, the artifact or recorded outcome for `prototype` / `task`.
- Read-only: nothing is written to the ticket.

## 6. Classify

From the per-claim results and deliverable presence, in this precedence:

1. Deliverable absent: **not implemented**.
2. Else any claim unmet: **implemented wrong**.
3. Else all claims met: **implemented**.

Independently, **any inconclusive claim flags the ticket unverifiable in part**. It is reported with its reason class beside its class (a mixed result shows both), and it rewinds the marker (step 10). A ticket whose deliverable is present, with only inconclusive claims and no unmet one, is plain **unverifiable**: no fix proposal, offered for a re-run instead.

## 7. Compare the open tickets

Open tickets in scope are compared inline, in two stages that favour recall:

- **(a)** Read every ticket's title and its `## Question` / `## Outcome` sections (one paginated listing with bodies, so no per-pair cost) and judge them all together **by meaning, not by shared words**. Keep **every** pair or cluster that might be a duplicate or groupable, uncertain ones included.
- **(b)** Re-read the full body and comments only for those candidates, and confirm or discard each.

Findings:
- **Duplicates**: the same deliverable.
- **Groupable clusters**: the same scope or seam, small enough to land as one ticket, and **the same type**. Only tickets of one type merge, so the merged ticket keeps that type and its engine. Mixed-type overlaps are reported as related, never proposed for grouping.
- Grouping never crosses a map boundary. A cross-map duplicate is **reported only**.
- **Claimed tickets are related only.** Exclude from duplicate and merge proposals any ticket with an assignee other than the current user (`gh api user --jq .login`) or holding a `PAUSED` checkpoint: another session is working on it, so report it as related and never propose touching it.

Over 60 open tickets in scope, run stage (a) per map plus one cross-map pass over titles and Questions only, and say so.

## 8. Report

One consolidated report: counts per class (implemented, implemented wrong, not implemented, unverifiable), then each non-implemented or unverifiable ticket by name and number with a one-line reason, then the duplicate and groupable findings. Nothing has changed yet.

## 9. Proposals, each on an explicit yes

One proposal per finding, shown one at a time, applied only on an explicit yes. On anything else, skip it and change nothing. Before a duplicate or merge proposal is even shown, **simulate the resulting dependency graph** (the transferred blockers and re-pointed dependents) and drop or reshape any proposal that would create a cycle, saying why. Just before applying any proposal, **re-read** what it touches (the ticket's state, labels, blockers and dependents, and for a duplicate or a group every ticket involved, including the assignee and `PAUSED` check: a ticket claimed since the report is dropped from the proposal). If an earlier fix in the same run, or a concurrent change, made it stale, say so and re-propose or drop it; never apply a stale proposal. The reopen, duplicate and merge proposals are **human-owned**: ask them as plain yes/no, never with the delegate option.

- **Implemented wrong** → a new `bug` carrying `Regression of: <ticket>`, via the capture cluster's `bug --of <n>` (a bug in already-closed work is always a new ticket; see the capture cluster's `bug` engine in `../../trailhead-capture/`).
- **Not implemented** → `gh issue reopen <n>` plus a comment stating the gap (the premature-close branch of new-bug-versus-reopen).
- **Duplicate** → first **carry the duplicate's wiring onto the kept ticket**, in all three views (the `## Blocked by` line, the native `blocked_by` edge, the `trailhead:blocked` label): each open dependent of the duplicate is re-pointed to the kept ticket unless already wired there, and each open blocker of the duplicate that the kept ticket lacks is added to it (excluding the pair itself). Then close the newer one natively as a duplicate of the kept one, `gh issue close <n> --duplicate-of <k>` (this sets the `DUPLICATE` state reason the window filter reads), plus a comment naming the kept ticket. If the duplicate was one of the kept ticket's blockers, remove it from the kept ticket's `## Blocked by` line (the native edge auto-reflects the close) and drop `trailhead:blocked` from the kept ticket if that was its last open blocker. Its native sub-issue edge stays: the eager drop is reserved to superseded and out-of-scope closes, and `/trailhead:prune` reclaims closed edges under cap pressure.
- **Groupable** → **supersede-and-merge**, the reverse of the split in `../../_shared/teamwork.md`. Open one merged ticket on the same map or whiteboard (create-then-wire). Its blockers are the union of the originals' open blockers **minus the group's own members**, wired in all three views (the `## Blocked by` line, the native `blocked_by` edge, and the `trailhead:blocked` label at creation). Every dependent of an original **outside the group** is re-pointed onto the merged ticket in all three views (body line edited, native edge added to the merged ticket; the original's edge reflects its close on its own). Intra-group edges are dropped, never re-pointed, so the merged ticket never blocks on, or depends on, itself. The merged ticket's body carries a `Merged from: <name+link>, ...` provenance line (mirroring split's `Split from:`). Then close each original as `trailhead:superseded` with the eager edge drop and a closing comment linking the merged ticket.

## 10. The marker advance (last, and confirmed too)

The marker advance is the **last proposal** of the run, shown with its value and applied **only on an explicit yes**, like every other change: a declined advance leaves the window exactly as it was.

- Write it only when the run covered **every map plus the whiteboard**. A `[map]`-scoped run never advances the repo-wide marker, or the other maps would skip closes nobody audited.
- Never advance from an incomplete run (step 3).
- The value is the **cutoff captured in step 2**, never the completion time, so a ticket closed mid-run falls into the next window.
- If any ticket ended **unverifiable**, write instead the earliest unverifiable ticket's `closedAt` minus one second (never past the cutoff), so the next default run picks it up again. No extra state, nothing silently dropped.
- Write it into the dashboard body with the fail-safe read-modify-write (see Body generation in `../../_shared/substrate-commands.md`). `--all` advances it the same way.

## Notes

- The audit never edits a ticket's body, labels, or state except through a confirmed proposal above.
- The marker lives in the pinned dashboard body, so it is repo-scoped and survives across machines.
- A closed ticket the audit classes **implemented** is left alone: no comment, no label.
