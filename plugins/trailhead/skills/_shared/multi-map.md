## Multiple maps on one repo (parking & concurrency)

By default a repo has **one live map** and the frontier is the whole repo (as everywhere above). But you can **park a map to work another**, and a teammate can chart a second map on the same repo and work it concurrently. When more than one `trailhead:map` is open, each map carries **its own frontier**, kept separate by two mechanisms wired together (the same "one fact, two views" pattern as a blocker's native edge + label):

- **Native sub-issue**: every ticket is a **sub-issue of its map** (`gh api --method POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id=<ticket .id>`). This is the structure GitHub renders (the map shows its children + a progress bar); it carries the `Parent:` line's meaning as a real edge.
- **Per-map label `trailhead:map-<n>`** (n = the map issue's own number): on **every one of its tickets** (not on the map issue itself, which is identified by its number, and would only be redundantly "a member of itself"). This is the **queryable key** that scopes the frontier to one query, because native sub-issues aren't cheaply filterable in a single search (exactly as with `blocked_by`), so the label carries the query.

Both are set at chart and on every ticket **in the same pass** (create the ticket → set its map parent → add its map label), so they can't drift.

**Scoped frontier** (one query, per map):
```bash
gh issue list --label "trailhead:ticket" --label "trailhead:map-<n>" --state open \
  --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
```

**Active map.** Which map a session works is the **active map**: a `.trailhead/active-map` marker at the working root (one line `#<n>`, **gitignored**, per-session local state like `session-ticket`, never committed). `/trailhead:work` and `/trailhead:map` default to it; naming a map/ticket explicitly always overrides. Each checkout/clone (so each teammate) has its own.

**Park & switch** = **pause** the in-flight ticket (`/trailhead:pause`, a `PAUSED` checkpoint), then point the active map at the other's number. Nothing else to save: every map lives on the Issues, durable. Resume later with `/trailhead:resume`, or just `/trailhead:work` once that map is active again.

**Discovery.** `gh issue list --label "trailhead:map" --state open` enumerates the live maps. `/trailhead:map` with **no active map and more than one open** lists them and asks which; `/trailhead:map <n>` shows that one and makes it active.

**Pinning with several maps.** No map is ever pinned. The 3 pinned slots are the permanent repo anchors: **dashboard + codebase + conventions**. Every open map is found via the `trailhead:map` label and listed in the pinned [dashboard](../trailhead-view/SKILL.md), so all of them stay reachable regardless of how many are live, without contending for a slot.

**Team.** A teammate charts a new map → it gets its own `trailhead:map-<m>` + sub-issue parentage → their sessions scope to it. The two frontiers **never mix** (distinct labels). Per-ticket **claim/collision** rules are unchanged (the assignee is still the claim). Two maps can still touch the **same code**: the `Scope:` line + `isolation:` serialisation from [Working as a team](teamwork.md#working-as-a-team) now apply **across maps too**, not just within one.

**One-map compatibility.** With a single open map the frontier stays **repo-wide** (minus `trailhead:whiteboard` tickets, which carry their own frontier, see [The whiteboard](../trailhead-view/SKILL.md)); the map label + sub-issue are still applied at chart, so concurrency is ready the moment a second map appears. An older map charted before this (tickets lacking the label) needs a one-time **backfill** (add `trailhead:map-<n>` to its open tickets, set their sub-issue parent) only if you add a second map on that repo.

