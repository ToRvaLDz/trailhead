# Auditing closed work and open overlap

`/trailhead:audit [map] [--all]` answers two questions about a repo's tickets: is each closed one **still true against today's code** (it hunts **regressions over time**, not just close-time delivery), and are any open ones duplicates or small enough to land together? Unchanged code is checked cheaply and deterministically, with no agent; the full agent verification is kept for the tickets whose code actually moved. The first run (no marker) covers the whole closed history; later runs keep the marker window. It is **read-only until you confirm**: the verification and the comparison only read, the result is one consolidated report, and every change that follows is a separate proposal applied only on an explicit yes. Nothing is written to GitHub before that.

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

**Skip only what delivered nothing by design**: `trailhead:superseded`, `trailhead:out-of-scope`, and tickets closed with GitHub's native duplicate state reason (read it through GraphQL or `gh --json stateReason`, which gives `DUPLICATE`, or through REST `state_reason`, which gives `duplicate`; the audit's own duplicate close below sets it). Every other closed ticket is checked, **type-aware** (step 4 does the routing):

- `build` / `bug`: the **fast path** (no agent) against the commits that carry `Refs: #<n>`; the full agent verification only where that path finds the code changed or has nothing to compare.
- `decision` / `research` / `task` / `prototype`: a **light inline check** (no agent) of the recorded answer or outcome. Whether code honours a decision is covered by the build tickets that implemented it.

## 3. Enumerate exhaustively

Every listing the audit relies on (the closed set, the open set, blockers, dependents) must be **complete**, never `gh issue list`'s default page. Every search query carries `is:issue label:trailhead:ticket`, and any REST `/issues` listing drops items that have a `pull_request` key, so a PR is never audited as a ticket. Use `gh api --paginate` (search or issues endpoints, `per_page=100`), or the native `blocked_by` / `blocking` endpoints with `--paginate`. The search API caps at 1000 results and `--paginate` stops there silently, so for every search compare the response `total_count` with the number of items fetched and check `incomplete_results`. If `total_count` exceeds 1000 or `incomplete_results` is true, **split the window by date ranges** (bisect the `closed:` range) until each slice is complete, then merge the slices. If a slice cannot be made complete, or any listing errors or comes back truncated, **stop and report it**, and never propose a marker advance from an incomplete run.

## 4. Fast path, light check, and cost guard

Run in this order, so the cost guard counts only what the cheap passes leave over. The audit judges **HEAD** (committed code).

**Fast path** for `build` / `bug` (deterministic, no agent):

- **The ticket's commits** (those carrying `Refs: #<n>`): run the trailer scan **once per audit**, a single `git log --format='%H%x00%(trailers:key=Refs,valueonly,separator=%x2C)' HEAD` pass indexed by ticket number (never one scan per ticket), keeping for each ticket the HEAD-reachable commits whose **parsed `Refs:` trailer** names `#<n>` as a delimited token. `Refs: #17, #192` counts for #192, `#19` never matches `#192`, and a `Refs:` line in the prose body is ignored. The same trailer parse reads a producer's `Refs:` in the attribution walk (step 6). A ticket with **no `Refs:` commits** has nothing to compare: it is **agent-bound** (and can never be classed evolved, step 6).
- **Baseline**: `<last>` is the newest ticket commit and must contain every other one (`git merge-base --is-ancestor <c_i> <last>` for each). The ticket is **assumed delivered at `<last>`**: its lines are what blame attributes to its commits there. Cheap guard: any non-ticket commit on the chain between the first ticket commit and `<last>` that touches one of the ticket's files makes the ticket agent-bound (conservative). A **non-linear** set (ticket commits on incomparable branches) has no single baseline: the ticket is agent-bound and ineligible for evolved.
- **The ticket's lines**: the touched files are the union of `git show --name-only` over its commits. For each file, the ticket's lines at `<last>` are the lines `git blame --porcelain <last> -- <file>` attributes to one of the ticket's commits.
- **Pure deletions**: for a ticket hunk `-a,k +b,0` in ticket commit `c_i`, the **anchor** is the gap after post-image line `b` of `c_i` (file start: `b=0`, so line 1). It moves from `c_i` to `<last>` along the same chain-and-replay procedure as step 6 (chain from `<last>` back to `c_i` via the first parent descending from `c_i`, replayed forward), and any hunk on that stretch touching the anchor, ticket commit or not, is handled by the usual shift: a later ticket commit's own edits are part of the ticket, while a non-ticket commit touching the anchor before `<last>` makes the ticket agent-bound (conservative). At `<last>`, a later hunk whose old-side range covers line `b` or `b+1`, or a pure insertion at old-side position `b` (`-b,0`), touches the anchor. A file the ticket deleted counts as changed only if the path exists again at HEAD. An empty file at `<last>` carries no lines; it is changed if HEAD differs.
- **Touching** (one rule for the fast path and the walk): a hunk touches the ticket when its old-side range overlaps a tracked line, or covers or sits at an anchor, or is a **pure insertion** (`-b,0`) with line `b` or `b+1` tracked, so an insertion inside or at the edge of the ticket's span counts. In the walk, a touching insertion's new lines become tracked and inherit the lineage of their tracked neighbours (and any anchor they sit at) plus `c`.
- **Decide**: `git diff -U0 <last>..HEAD -- <files>`. Any touching hunk, a touched file deleted or renamed since, a file where `git diff --quiet <last> HEAD -- <file>` reports a difference but `-U0` yields no textual hunk (binary, mode-only), or any git error: **changed**, agent-bound. Otherwise **implemented (unchanged)**, whatever the close-time `VERIFY` looked like (old formats vary, so no close-time verify is required).
- **Shallow clone** (`git rev-parse --is-shallow-repository` prints `true`): say so and send every `build` / `bug` to the agent. Such tickets are also **ineligible for evolved**: blame at the shallow boundary inflates the tracked set.
- **Dirty working tree**: the audit judges HEAD and ignores uncommitted work, and the step 5 agent reads code at HEAD, never the working tree. If `git status --porcelain` lists any of a ticket's touched files (modified or untracked), the report notes them (the user may want to commit first). That changes nothing else: no agent-bound effect, no evolved ineligibility. A clean tree needs nothing.

**Light check** for `decision` / `research` / `task` / `prototype` (inline, no agent): the recorded answer or outcome exists and answers the Question: a resolution comment, or its map `Decisions so far` line, or the linked artifact or stated resulting facts. A missing one is **not implemented**; an unclear one is unverifiable. There is no code check.

**Cost guard**: count the **agent-bound set** only (never the fast-path or light-check tickets). When it **exceeds 20** tickets, show the count and ask whether to proceed, narrow to one map, or cancel. At 20 or fewer, go straight on.

## 5. Verify the closed set

Dispatch each agent-bound ticket to a **`trailhead-verify`** agent (see `../../_shared/techniques.md` for dispatch, the `config.models.verify` model override, and the inline fallback), in parallel **batches of 5**, background and polled: reviews never block the session. The verification protocol is `../../_shared/techniques/verify.md`; this audit states its own brief on top of it, and `verify.md` itself is unchanged.

**Audit-mode brief**, handed to each agent:
- Work goal-backward against the **current HEAD code** (read it with `git show HEAD:<file>`, never the working tree, so every range it returns is a HEAD range) and the ticket's own Question / Outcome / PLAN criteria.
- Use the ticket's `Refs: #<n>` commits as evidence when present. For the audit, this brief **overrides two rules of `techniques/verify.md`**: an **empty Refs set is evidence, not an error** (old or manually closed tickets carry none, so verify against HEAD and the recorded answer or outcome instead), and the agent **posts nothing** (it returns its verdict to the caller, never a `VERIFY` comment).
- Return a result **per claim** (met / unmet / inconclusive, each inconclusive with its reason) **plus whether the deliverable is present**: code for `build` / `bug`.
- For each **unmet** claim, return the **HEAD `file:line` ranges** that carry (or should carry) its evidence. For an **absent deliverable**, return the HEAD ranges (or the deletion gaps) where the deliverable used to live. Without ranges, neither can ever be classed evolved (step 6).
- Read-only means **no writes of any kind** (no comments, edits, labels, or state changes), on the ticket or anywhere else. **Reading is expected**: the ticket and its comments, the map issue body (glossary, Decisions so far, Notes), linked or blocking tickets, and the repo code and history. A claim whose evidence lives in an issue must be evaluated by reading it, never left inconclusive for that reason.

## 6. Classify

From the per-claim results and deliverable presence, in this precedence:

1. Deliverable absent: **evolved by #m** if the absence is attributed (below, over the HEAD ranges the agent returned for the deliverable (step 5)), else **not implemented**.
2. Else any claim unmet: **evolved by #m** only when **every** unmet claim is attributed, else **implemented wrong**.
3. Else all claims met: **implemented**.

The agent still runs on every changed ticket; there is no shortcut that classes "changed only by other tickets" as evolved without verifying. A ticket with no `Refs:` commits, a non-linear set, or a shallow clone has no trustworthy baseline and can never be classed evolved: an unmet claim there stays **implemented wrong** (the conservative side: the regression stays visible as a proposal the user can decline).

**Attribution contract** (deterministic, by the caller, one mechanism for edits and deletions): a **forward walk** from `<last>` to HEAD.

- **Start** from the ticket's tracked lines and deletion anchors at `<last>` (the fast-path set). For each file that the unmet claim's (or the absent deliverable's) HEAD ranges name, walk the **path from `<last>` to HEAD**: from HEAD, step back to the first parent `p` with `git merge-base --is-ancestor <last> p` true, until `<last>`, then replay that chain forward.
- **Per commit** `c` on the chain: first read `git diff -M --name-status p c` with **no pathspec**, so a rename `R<score> <file> <new>` is seen with both names, and skip `c` when it does not list the tracked path. Otherwise read `git diff -M -U0 p c -- <file> [<new>]` against its chosen parent `p`: a **touching** hunk (rule in step 4) makes `c` a **producer**. Then shift the tracked lines and anchors through the hunk: the new-side lines of a producer hunk (replacements and insertions) **become tracked**, deleted tracked lines leave an anchor that **inherits the deleted lines' lineage plus `c`**, and lines outside any hunk move by the hunk's line delta.
- **Lineage**: each tracked line and anchor carries the producers that touched it on the way to HEAD. A new-side line inherits the lineage of the tracked lines and anchors its hunk replaced, plus `c`. A deleted tracked line's anchor inherits the deleted lines' lineage plus `c`. A touching pure insertion's new lines inherit the lineage of their tracked neighbours (and any anchor they sit at) plus `c`.
- **Delete and rename**: a file deleted in `c` makes `c` a producer and ends the walk for that file. A rename updates the tracked path to `<new>` and the walk keeps the same chain; `c` is a producer only if its `p..c` diff also has a touching hunk (a pure rename is not).
- **Merge** `c` on the chain: expand it to the side commits that produced its touching hunks. For the **new-side lines** of a touching hunk, `git log --format='%H%x00%(trailers:key=Refs,valueonly,separator=%x2C)' -L<s>,<e>:<file> p..c` (range in `c`'s coordinates, history limited to what `c` brings beyond `p`) lists every commit that touched those lines, intermediate overwritten ones included, plus `c` itself when the merge changed them (conflict resolution); all of them are producers. Trust that trace only on a simple side history, checked **without any pathspec**: if `git rev-list --merges p..c` lists a merge other than `c` itself (a nested merge), or `git log -M --name-status --format= p..c` lists an `R` line naming the file on either side, or any command fails, the producer is **`c` itself** instead (conservative). For **old-side tracked lines a touching hunk deletes** there is no surviving line to follow, so the producer is **`c` itself**, judged by its own trailer (usually none). Coordinates still advance by the `p..c` diff, so the chain stays single.
- **Only the claim's own lineage counts**: the producers are those in the lineage of the tracked lines and anchors that the claim's HEAD ranges overlap (for an absent deliverable, the HEAD ranges where the deliverable was), so an unrelated later edit elsewhere in the same file never attributes the claim.
- **Attributed** when that lineage holds at least one producer and **every** producer carries a parsed `Refs:` trailer naming some `#m` with m != n. A producer with no `Refs:` trailer (an edit no ticket tracks), or no producer at all, means not attributed. Name every evolving ticket.

Independently, **any inconclusive claim flags the ticket unverifiable in part**. It is reported with its reason class beside its class (a mixed result shows both), and it rewinds the marker (step 10). A ticket whose deliverable is present, with only inconclusive claims and no unmet one, is plain **unverifiable**: no fix proposal, offered for a re-run instead.

## 7. Compare the open tickets

Open tickets in scope are compared inline, in two stages that favour recall:

- **(a)** Read every ticket's title and its `## Question` / `## Outcome` sections (one paginated listing with bodies, so no per-pair cost) and judge them all together **by meaning, not by shared words**. Keep **every** pair or cluster that might be a duplicate or groupable, uncertain ones included.
- **(b)** Re-read the full body and comments only for those candidates, and confirm or discard each.

Findings:
- **Duplicates**: the same deliverable.
- **Groupable clusters**: the same scope or seam, small enough to land as one ticket, and **the same type**. Only tickets of one type merge, so the merged ticket keeps that type and its engine. Mixed-type overlaps are reported as related, never proposed for grouping.
- Grouping never crosses a map boundary. A cross-map duplicate is **reported only**.
- **Claimed tickets are related only.** Treat any open ticket with any assignee (trailhead runs as your own `gh` account, so a ticket another live session of yours claimed with `--add-assignee @me` counts too) or holding a `PAUSED` checkpoint as claimed: another session is working on it, so report it as related only and never propose it for duplicate-close or supersede-and-merge. This holds for the pair or group as a whole: if any member of a duplicate pair or merge group is claimed, the whole pair or group is reported as related only and never proposed, so a claimed kept ticket never gets blockers added or dependents re-pointed onto it.

Over 60 open tickets in scope, run stage (a) per map plus one cross-map pass over titles and Questions only, and say so.

## 8. Report

One consolidated report: counts per class, which must sum to the audited set (each ticket is counted **once by its primary class**, the step 6 precedence, and plain unverifiable only when no unmet claim exists): implemented (by the agent or by the light check, giving the light-check share), **unchanged**, **evolved**, implemented wrong, not implemented, unverifiable, then each evolved ticket by name and number with the evolving ticket(s), then each other non-implemented or unverifiable ticket by name and number with a one-line reason, the tickets **also unverifiable in part** listed separately, **outside the sum**, then the duplicate and groupable findings, and any dirty-file note or shallow-clone note from step 4. Nothing has changed yet.

## 9. Proposals, each on an explicit yes

One proposal per finding, shown one at a time, applied only on an explicit yes. On anything else, skip it and change nothing. Before a duplicate or merge proposal is even shown, **simulate the resulting dependency graph** (the transferred blockers and re-pointed dependents) and drop or reshape any proposal that would create a cycle, saying why. Just before applying any proposal, **re-read** what it touches (the ticket's state, labels, blockers and dependents, and for a duplicate or a group every ticket involved, including the check for any assignee or a `PAUSED` checkpoint: a ticket claimed since the report is reported as related only and dropped from the proposal, and if any member of the pair or group is claimed the whole proposal is dropped to related only, and for an implemented-wrong proposal the existing `Regression of:` search below is repeated). If an earlier fix in the same run, or a concurrent change, made it stale, say so and re-propose or drop it; never apply a stale proposal. The reopen, duplicate and merge proposals are **human-owned**: ask them as plain yes/no, never with the delegate option.

- **Implemented wrong** → a new `bug` carrying `Regression of: <ticket>`, via the capture cluster's `bug --of <n>` (a bug in already-closed work is always a new ticket; see the capture cluster's `bug` engine in `../../trailhead-capture/`). Before proposing it for ticket <n>, search exhaustively (`is:issue`, open, or closed after <n>'s `closedAt`) for an existing ticket whose body carries `Regression of:` pointing at <n> (match the number or its URL). If one exists, report <n> as already tracked, naming that ticket, instead of proposing a new bug; this prevents duplicates when a rewound marker re-audits tickets.
- **Not implemented** → `gh issue reopen <n>` plus a comment stating the gap (the premature-close branch of new-bug-versus-reopen).
- **Evolved** → no proposal: listed in the report only, because a later ticket changed the code on purpose.
- **Duplicate** → first **carry the duplicate's wiring onto the kept ticket**, in all three views (the `## Blocked by` line, the native `blocked_by` edge, the `trailhead:blocked` label): each open dependent of the duplicate is re-pointed to the kept ticket unless already wired there, and the union of blockers is built by adding each open blocker of the duplicate that the kept ticket lacks, both **excluding the pair itself** so the kept ticket is never re-pointed onto itself or made to block on itself. Then close the newer one natively as a duplicate of the kept one, `gh issue close <n> --duplicate-of <k>` (this sets the `DUPLICATE` state reason the window filter reads), plus a comment naming the kept ticket. If the duplicate was one of the kept ticket's blockers, that edge is removed (the native edge auto-reflects the close; also drop it from the `## Blocked by` line) instead of transferred, and the kept ticket's `trailhead:blocked` label is re-evaluated only after the duplicate's blockers have been added to it: drop `trailhead:blocked` if that was its last open blocker. Its native sub-issue edge stays: the eager drop is reserved to superseded and out-of-scope closes, and `/trailhead:prune` reclaims closed edges under cap pressure.
- **Groupable** → **supersede-and-merge**, the reverse of the split in `../../_shared/teamwork.md`. Open one merged ticket on the same map or whiteboard (create-then-wire). Its blockers are the union of the originals' open blockers **minus the group's own members**, wired in all three views (the `## Blocked by` line, the native `blocked_by` edge, and the `trailhead:blocked` label at creation). Every dependent of an original **outside the group** is re-pointed onto the merged ticket in all three views (body line edited, native edge added to the merged ticket; the original's edge reflects its close on its own). Intra-group edges are dropped, never re-pointed, so the merged ticket never blocks on, or depends on, itself. The merged ticket's body carries a `Merged from: <name+link>, ...` provenance line (mirroring split's `Split from:`). Then close each original as `trailhead:superseded` with the eager edge drop and a closing comment linking the merged ticket.

## 10. The marker advance (last, and confirmed too)

The marker advance is the **last proposal** of the run, shown with its value and applied **only on an explicit yes**, like every other change: a declined advance leaves the window exactly as it was.

- Write it only when the run covered **every map plus the whiteboard**. A `[map]`-scoped run never advances the repo-wide marker, or the other maps would skip closes nobody audited.
- Never advance from an incomplete run (step 3).
- The value is the **cutoff captured in step 2**, never the completion time, so a ticket closed mid-run falls into the next window.
- An **unchanged** or **evolved** ticket never rewinds the marker.
- If any ticket was flagged **unverifiable**, in whole or in part (step 4 or step 6), write instead the earliest unverifiable ticket's `closedAt` minus one second (never past the cutoff), so the next default run picks it up again. No extra state, nothing silently dropped.
- Write it into the dashboard body with the fail-safe read-modify-write (see Body generation in `../../_shared/substrate-commands.md`). `--all` advances it the same way.

## Notes

- The audit never edits a ticket's body, labels, or state except through a confirmed proposal above.
- The marker lives in the pinned dashboard body, so it is repo-scoped and survives across machines.
- A closed ticket the audit classes **implemented**, **unchanged**, or **evolved** is left alone: no comment, no label.
