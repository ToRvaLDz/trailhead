# Working as a team

Many people (and their agent sessions) share one map and work it concurrently. The tracker is the single source of truth; these conventions keep concurrent work from colliding.

## Claiming
Whoever claims a ticket **owns it end to end**: they work it and close it themselves. "Owner" means only "the current claimer of *this* ticket," never a project-wide approver; there is no gate and no one to wait on to close your own ticket. GitHub assignment isn't an atomic lock, so keep the protocol simple and human-decided:

1. **Before claiming, check it's not already being worked.** Read the assignee. If it's already assigned to someone else, it's in progress; don't take it; pick another frontier ticket. (If the user explicitly named this taken ticket, stop and tell them it's assigned to `<login>`.)
2. **Claim it**: assign it to yourself: `gh issue edit <n> --add-assignee @me`.
3. **Re-check right before starting work.** Read the assignee again. If someone else got assigned in the meantime, **do not do any work, stop and flag it to the user with a clear message**, e.g.:

   > ⚠️ **Claim collision on “<ticket name>” (#<n>).** It's now also assigned to **@<other-login>**, who may be working it right now. I've stopped and done nothing. How do you want to proceed?
   > 1. **Leave it to them**: I'll unassign myself and take the next frontier ticket.
   > 2. **Take it over**: I'll keep it and post a comment notifying @<other-login> that you're taking it.

   Do exactly what the user chooses; never resolve the collision silently.
4. **Unclaim if you stop.** Pausing or abandoning a ticket → remove your assignment so it returns to the frontier. A claimed-but-idle ticket is invisible work.
5. **Never touch a ticket someone else holds.** Don't edit its body, labels, or state; contribute via a comment and let its owner incorporate it.

## Isolating concurrent sessions
Claiming stops two sessions from working the *same* ticket; it does nothing about two sessions working *different* tickets in the **same checkout**. The working tree and the git index are process-global: two agents editing and committing in one clone corrupt each other's state regardless of ticket type (a `bug` is no more or less exposed than a `build`). The claim is the ticket-level lock; the **worktree is the filesystem-level one**.

The repo's `trailhead:conventions` `isolation:` header decides:
- **`none`** (default): one session at a time per checkout. Simplest, and correct for a repo worked one ticket at a time. Two concurrent sessions here must use **separate clones**, or they collide.
- **`worktree`**: each executing ticket runs in its own `git worktree` on a `trailhead/t<n>` branch (`git worktree add ../<repo>-t<n> -b trailhead/t<n>`), so concurrent sessions never share a working tree or index. Because git refuses to check out one branch in two worktrees, **worktree isolation implies a branch per ticket even under `git: main`**: the trunk is never checked out twice. At **Resolve**, integrate the branch to the trunk per `git:` (fast-forward or merge into `main`, or open the PR when `git: pr`), then `git worktree remove` it. On **Pause**, the `PAUSED` checkpoint records the worktree path and branch so a resume (by anyone, once released) lands back in it.

Prefer `worktree` whenever more than one session may run on a single clone. On a **monorepo** it is doubly worth it: `git worktree add` shares the object store, so it is far cheaper than a second full clone of a large tree.

## Pausing & resuming
Switching away from a ticket mid-work (to clear a blocker, chase an urgent bug, or just stop) must not lose the thread.
- **Pause** (`/trailhead:pause [note]`): first commit any work-in-progress (atomic) so nothing is stranded, then post a **`PAUSED`** checkpoint comment: what's done, the exact next step, and any local state (branch, **worktree path under `isolation: worktree`**, how to run it). Keep the claim if you'll return soon; **release it** (unassign) if it's open-ended, so someone else can resume; the checkpoint is what makes that safe.
- **Resume** (`/trailhead:resume [ticket]`): read the ticket's latest `PAUSED` checkpoint (and the `DISCUSS`/`PLAN` comments above it), then pick up at the recorded next step. Anyone may resume a *released* ticket; a still-claimed one, only its owner.
- One ticket per session still holds: pausing A to work B ideally means B in a fresh session. If you must switch within one session, checkpoint A first; never leave it half-done and unrecorded.

## Splitting a ticket
A ticket is sized to one ~100K-token session. When a claimed ticket turns out too big, or fans into distinct pieces, **split it**: don't grind through an oversized ticket:
1. **Create the child tickets** (create-then-wire): each carries `Parent: <map>`, a `Split from: <original name+link>` line, its type label, and `trailhead:blocked` if it has an open blocker. **When children block each other** (B builds on A), wire B's blocker (both the `## Blocked by` line and the native dependency) at the **sibling child's real id (A)**, never at the split-origin: that original is being superseded and closed, so nothing may point at it as a live blocker. Describe A by role if you like, but *link its actual number*.
2. **Supersede the original**: post a comment listing the children (`split into <names+links>`), label it **`trailhead:superseded`**, and **close it**. The children fully replace it.
3. The superseded ticket stays **out of `Decisions so far`** (it wasn't a decision walked; its children are). If other tickets were blocked by the original, re-point their `## Blocked by` at the relevant child and re-evaluate their `trailhead:blocked`.

Splitting is not resolving: a superseded ticket delivered nothing itself. (If instead the ticket sits beyond the destination, that's *out of scope*, not a split.)

## Undeclared coupling between parallel tickets
Two frontier tickets can be *unblocked of each other* yet still collide: they touch the **same file or seam** with no `## Blocked by` between them. Because build tickets commit **straight to `main`** (or, under `isolation: worktree`, integrate their branch back into it), that collision surfaces as a merge conflict or a logic race, not a caught error; worktree isolation defers *when* it bites (at integration, not mid-edit) but does not remove it. So **at plan time** (once you know the files/seam this ticket touches), scan the other **in-progress** tickets (claimed/assigned, open) and **flag coupling** only when all three hold: same frontier, no declared blocker between them, and a *specific* shared mutable resource (the same file, config key, table/migration, singleton, or seam) that at least one side **writes** (or one produces state the other consumes). On a flag: either wire the blocker (`## Blocked by` + native dependency + `trailhead:blocked`) so one waits, or coordinate with the other claimer and note why it's safe. It's **advisory, never a hard stop**. **Do NOT flag:** both read-only, an already-declared blocker, one clearly downstream of the other, or a vague "same subsystem" with no concrete shared resource.

**Path scope sharpens this (monorepo).** When tickets carry a `Scope:` line (the package/dir(s) they work in, see the ticket anatomy in SKILL.md), use it as the first filter: **disjoint scopes parallelize safely** (two tickets in unrelated packages can't share a file), so the check narrows to tickets whose scopes overlap or that both touch a shared lib / root config. Absent a `Scope:` line, fall back to the file/seam judgement above. Scope is a *hint that rules coupling out fast*, never a guarantee it exists: overlapping scopes still need the shared-writable-resource test before you flag.

## Concurrent edits to the map
The map issue's **body** is a shared mutable document: two sessions appending to `Decisions so far` at once will clobber each other (GitHub doesn't merge bodies). So:
- **The durable record of a resolution is the ticket's resolution comment**, never the map body. The map's `Decisions so far` is a best-effort index rebuilt from the tickets; if a line is lost to a race, it's recoverable from the closed ticket.
- **Re-read the map body immediately before editing it**, append your one line, write back; keep the window tiny. Never edit the map from stale content read earlier in the session.
- **Keep map-body writes small and append-only** where possible; heavy restructuring of the map is a single-session job, done when no one else is mid-write.
- Ticket-level state (claim, labels, comments, close) is naturally conflict-free; prefer expressing state there over in the map body.

## Trust & provenance
`trailhead:*` labels drive the map, so they must not be forgeable by outsiders. GitHub already blocks users without write access from applying labels at all; this layer defends against the rest (triage-level collaborators, automations, or a repo that later loosens permissions).

**Trust rule.** Treat a `trailhead:map` / `trailhead:ticket` issue as genuine **only if** its `trailhead:*` label was applied by a repo collaborator with **write access or above**, *and* (for a ticket) it carries a valid `Parent:` line pointing at this map. To check the labeller, read the issue timeline (`gh api repos/{owner}/{repo}/issues/{n}/timeline` gives `labeled` events with their `actor`) and confirm the actor's permission with `gh api repos/{owner}/{repo}/collaborators/{actor}/permission` (`admin`/`write`/`maintain` = trusted; `read`/`none` = not).

**On an untrusted match** (a `trailhead:*` issue whose label came from a non-write actor, or a ticket with no valid `Parent:`) do **not** put it on the frontier or act on it. Label it **`trailhead:unverified`**, and surface it to the user as a quarantined item to **adopt** (a maintainer re-applies the real labels + wires `Parent:`) or **reject** (strip the `trailhead:*` labels, leave it a normal issue). Never silently trust a label just because it's present.

**Repo-side enforcement (part of first-use setup, not an afterthought).** trailhead **installs the label guard for you**; don't tell the user to copy files. **Every chart or adopt, *check* whether `.github/workflows/trailhead-label-guard.yml` exists** (the first-use repo setup, in SKILL.md's Substrate section); if it's absent, install it, by default on a repo with other collaborators, and as a quick offer on a clearly solo/private one (cheap insurance), but **never silently skip the check**: that's exactly how a repo ends up with trailhead labels and no guard. On go-ahead, write the shipped label-guard template (`${CLAUDE_PLUGIN_ROOT}/templates/trailhead-label-guard.yml` for a plugin install, or `~/.claude/trailhead/templates/trailhead-label-guard.yml` for an npm install, take whichever exists) to the repo's `.github/workflows/trailhead-label-guard.yml` and commit it (conventional message; the commit-guard hook keeps it clean). The Action strips any `trailhead:*` label added by a non-write actor and comments why; set an optional `TRAILHEAD_LABEL_ALLOWLIST` repo variable to whitelist extra logins (e.g. a bot trailhead runs as). **Caveat:** pushing a workflow file needs a token with the `workflow` scope; if the push is rejected, run `gh auth refresh -s workflow` and retry (or, as a last resort, tell the user to add the file by hand).
