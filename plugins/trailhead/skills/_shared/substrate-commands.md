# Substrate: `gh` command cookbook + first-use repo setup

The single command reference for every `gh` mechanic the GitHub Issues substrate uses. Cluster skills link here and never re-describe any of it. The conceptual model (Element table, State labels, Frontier definition, reconciliation) stays in `substrate.md` (and its SKILL.md mirror). Read this file at work time (creating tickets, wiring blockers, querying the frontier, refreshing the dashboard) and at chart/adopt (first-use setup).

## Base commands
```bash
# create the map
gh issue create --label "trailhead:map" --title "<destination>" --body-file <body>
# create a child ticket (add trailhead:blocked too if it has an open blocker; add trailhead:map-<map> to scope it to its map)
gh issue create --label "trailhead:ticket,trailhead:build,trailhead:map-<map>" --title "<question/goal>" --body-file <body>
# link the ticket to its map: native sub-issue (structure/UI) + the map label above (the query)
gh api --method POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id="$(gh api repos/{owner}/{repo}/issues/<ticket> --jq .id)"
# wire a blocker: native dependency (visual frontier in the UI) + the trailhead:blocked label (the query)
gh api --method POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id="$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)"
# the label rides in the --label list at creation for a ticket already known-blocked (fires no issues.labeled event); use --add-label ONLY when a ticket becomes blocked LATER (a single event, never a bulk burst):
gh issue edit <blocked> --add-label "trailhead:blocked"
# the frontier: open, unassigned, not blocked, not unverified, one query (add --label trailhead:map-<map> to scope to one map when several are live; add -label:trailhead:whiteboard to a single-map repo-wide query to keep loose tickets off it)
gh issue list --label "trailhead:ticket" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified -label:trailhead:whiteboard"
# the whiteboard frontier: map-less loose tickets, its own query
gh issue list --label "trailhead:ticket" --label "trailhead:whiteboard" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
# unblock a ticket once its last blocker closes (label only; native edge auto-reflects)
gh issue edit <n> --remove-label "trailhead:blocked"
# claim
gh issue edit <n> --add-assignee @me
# resolve
gh issue comment <n> --body-file <resolution>   &&   gh issue close <n>
```
The wiring commands above (sub-issue link, blocker dependency) are elaborated below as full same-pass procedures.

## One fact in several views

Two facts each get written in three places, all in the same pass, so they can never drift apart.

**Child → map link (three views):**
1. A `Parent: <map name>(link)` line in the ticket body (human readable).
2. The native sub-issue edge:
   ```bash
   gh api --method POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id="$(gh api repos/{owner}/{repo}/issues/<ticket> --jq .id)"
   ```
   This is the structure GitHub renders, including the map's progress bar.

   The edge add is cap-aware: apply the `Parent:` line and the `trailhead:map-<n>` label FIRST (below), since they keep the ticket attached regardless of what happens next. Then, before the POST, read the map's current count:
   ```bash
   gh api repos/{owner}/{repo}/issues/<map> --jq '.sub_issues_summary.total'
   ```
   If it is >= 100, do NOT POST: tell the user the map is at GitHub's 100 sub-issue cap and offer `/trailhead:prune` to reclaim slots, then continue (the label already attached the ticket). If it is < 100, POST; if the POST itself still fails with a cap-signalling error (HTTP 422, or a "maximum number of sub-issues" message), treat it as at-cap and offer prune the same way. Any other POST failure is surfaced plainly as an ordinary error. Never silently drop the edge.
3. The map's `trailhead:map-<n>` label on the ticket: the queryable key that scopes the frontier.

Wire all three in the same pass; a ticket carrying only one or two has drifted. A whiteboard ticket has none of the three: no `Parent:` line, no sub-issue edge, no `trailhead:map-<n>` label.

**Blocker (three moves):**
1. A `## Blocked by` line in the ticket body, naming and linking the real blocker ticket.
2. The native dependency:
   ```bash
   gh api --method POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id="$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)"
   ```
3. The `trailhead:blocked` label. **Set it at creation** (include it in the `gh issue create --label` list) for any ticket known-blocked up front, which is every bulk path (the chart/adopt wiring second pass, split children, an on-the-fly ticket with a known blocker): the label then rides in the ticket's `issues.opened` event and fires **no** `issues.labeled` event. Reserve the post-creation `--add-label` form for a ticket that becomes blocked **later**, after it already exists (a single, non-bursty event):
   ```bash
   gh issue edit <blocked> --add-label "trailhead:blocked"
   ```
   **Why at creation.** The repo-side label guard (`.github/workflows/trailhead-label-guard.yml`) fires on `issues.labeled`. A setup pass that adds `trailhead:blocked` to many freshly-created tickets via `--add-label` fires a burst of `issues.labeled` events, one guard run each; GitHub sheds a fraction of that concurrent burst as `startup_failure`/`cancelled`, reddening the Actions history with no-op runs (the labeler is the authorized maintainer). Riding the label in `issues.opened` avoids the burst; moves 1-2 (the `## Blocked by` prose and the native dependency edge) still wire together in the second pass and fire no label event.

Same-blocker rule: all three must name the SAME blocker ticket, never a superseded parent, a split-origin, or a by-role placeholder ("child A"). Write the prose line and the native dependency from the same id, in the same pass, so they cannot point at different tickets.

Unblock: remove the label the moment the last blocker closes:
```bash
gh issue edit <n> --remove-label "trailhead:blocked"
```
The native edge needs no cleanup; GitHub auto-reflects a closed blocker on its own.

## Sub-issue cap and pruning

GitHub caps native sub-issues at 100 per parent. The engine reads this count wherever it matters (edge-add pre-check, dashboard flag) and `/trailhead:prune` reclaims slots when a map is near or at it. The classification (closed -> remove, open+labelled -> keep, open+not-labelled orphan -> remove, labelled-but-missing -> add) and the preview/confirm live in `../trailhead-manage/references/pruning.md`; this cookbook only holds the `gh` mechanics.

Read the count (>= 90 near cap, >= 100 at cap):
```bash
gh api repos/{owner}/{repo}/issues/<map> --jq '.sub_issues_summary.total'
```

List every native sub-issue edge, paginated (never a single page), capturing number, id, and state:
```bash
gh api repos/{owner}/{repo}/issues/<map>/sub_issues --paginate --jq '.[] | {number, id, state}'
```

Remove an edge (note the singular `sub_issue` on DELETE, vs the plural `sub_issues` on POST):
```bash
gh api --method DELETE repos/{owner}/{repo}/issues/<map>/sub_issue -F sub_issue_id=<id>
```
A DELETE that comes back 404 (Not Found) means that edge was never a native sub-issue of this map (already detached): the slot is already free, so treat it as success (a no-op reclaim), never as an error.

Re-add a missing edge: the same native sub-issue POST as the Child -> map link above, resolving the ticket's internal id first (the label diff that finds a missing ticket yields its issue *number*, not the internal id the endpoint needs):
```bash
gh api --method POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id="$(gh api repos/{owner}/{repo}/issues/<ticket> --jq .id)"
```

## Frontier queries

Map frontier, single map, repo-wide (excludes whiteboard tickets so they don't leak in):
```bash
gh issue list --label "trailhead:ticket" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified -label:trailhead:whiteboard"
```

Scoped map frontier, when several maps are live (add the map's label):
```bash
gh issue list --label "trailhead:ticket" --label "trailhead:map-<n>" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
```

Whiteboard frontier (its own query, off every map's):
```bash
gh issue list --label "trailhead:ticket" --label "trailhead:whiteboard" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
```

Blocked-by reconciliation read (drift check, advisory only, never auto-fix):
```bash
gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by
```
Compare the returned issue numbers against the ticket's `## Blocked by` prose. If the two sets differ, surface an advisory naming both sides; if the body has no parseable `## Blocked by`, report it uncheckable, never assume they agree.

## Dashboard (pinned repo index)

The dashboard is a single per-repo issue labelled `trailhead:dashboard`: the pinned index of the whole trailhead surface. It occupies the fixed 3rd pinned slot alongside `trailhead:codebase` and `trailhead:conventions` (a repo caps pinned issues at 3).

**Ensure the label** (idempotent, safe to run every time):
```bash
gh label create trailhead:dashboard --color 5319E7 --description "Pinned index of the trailhead surface" 2>/dev/null || true
```
The whiteboard label needs the same idempotent ensure, since it is reachable outside chart/adopt (a whiteboard-routed capture, or `quick` creating a ticket):
```bash
gh label create trailhead:whiteboard --color C5DEF5 --description "Map-less ticket: lives on the whiteboard" 2>/dev/null || true
```

**Find the dashboard issue:**
```bash
gh issue list --label trailhead:dashboard --state open --json number --jq '.[0].number'
```

**Read the repo's pinned issues**, to know whether the dashboard is currently among them:
```bash
gh api graphql -f query='
  query($owner:String!,$name:String!){
    repository(owner:$owner,name:$name){
      pinnedIssues(first:3){ nodes{ issue{ number } } }
    }
  }' -F owner={owner} -F name={repo}
```

**Two different ids, don't mix them.** GitHub exposes two different issue ids:
- The **REST numeric database id**: `gh api repos/{owner}/{repo}/issues/<n> --jq .id`. Used as `issue_id` / `sub_issue_id` for the sub-issues and dependencies REST endpoints (Child → map link and Blocker above).
- The **GraphQL node id**: `gh api repos/{owner}/{repo}/issues/<n> --jq .node_id`. Used for GraphQL mutations (`pinIssue` / `unpinIssue` below).

Passing the wrong one to an endpoint fails; always check which id a given command expects before running it.

**Pin / re-pin / unpin** (GraphQL, needs the node id):
```bash
DASH_NODE=$(gh api repos/{owner}/{repo}/issues/<n> --jq .node_id)
gh api graphql -f query='mutation($id:ID!){ pinIssue(input:{issueId:$id}){ issue{ number } } }' -F id="$DASH_NODE"
# unpin: mutation($id:ID!){ unpinIssue(input:{issueId:$id}){ issue{ number } } }
```

**Self-heal (three cases).** Run by every read-only entry point: bare `/trailhead`, the map render, the whiteboard render. Each time, first ensure the label (above), then:
1. No dashboard issue exists: create it, write the body once, pin it.
2. Dashboard issue exists but is not among the pinned issues: re-pin it.
3. Dashboard issue exists and is already pinned: do nothing.

These renders create and pin only when missing; they never rewrite the body.

**Exhausted-map advisory (all three entry points).** Since each entry point already lists the open maps to self-heal the pin, it also runs the per-map exhaustion check: the `0 open scoped issues?` pre-filter, then a fog confirm on each candidate (the `gh issue view <map> --json body` read in Body generation below), and for a candidate with no remaining fog it surfaces a one-line `exhausted · closeable` advisory with an offer to close: route any un-parked deferred `## Out of scope` line first (as the map render's exhaustion check does), then `gh issue close` on an explicit yes, never auto-close, and never a body rewrite here. On `/trailhead:map <n>` skip the map being rendered (its own exhaustion check already covers it); the advisory is for any other exhausted-but-open map.

**Body generation.** The body holds:
- a link to every open `trailhead:map`, found with `gh issue list --label trailhead:map --state open`. The dashboard only links; GitHub renders each map's sub-issue progress bar natively, so the dashboard does not recompute per-ticket progress itself. **Per open map, additionally run one cheap `0 open scoped issues?` count** (below) as a **pre-filter**: zero open scoped issues makes a map a **candidate** for exhausted-but-open, not a verdict. The count cannot see fog (the map body's `## Not yet specified` prose is never a separate issue, and a `trailhead:fog` issue carries no `trailhead:map-<n>` label), and exhausted means **no open tickets AND no fog left**. So before flagging, confirm the candidate's body `## Not yet specified` is empty with one `gh issue view <map> --json body` read; only a candidate with no remaining fog is flagged in the Maps section as `exhausted · closeable`. The count runs for every open map, but the body read is bounded to the (rare) candidates, so this stays cheap and within the dashboard-only-links spirit. The flag is a signal, not an action: the `/trailhead:dashboard` render offers to close such a map, never auto-closes it (the never-close-unprompted rule holds);
- **per open map, also flag GitHub's 100 sub-issue cap**: read `sub_issues_summary.total` (below) and flag `near cap · <total>/100` (total >= 90) or `at cap` (total >= 100). For only the (rare) at/near-cap maps, run one bounded native sub-issue list (see `## Sub-issue cap and pruning` above) to check for closed edges, exactly like the bounded fog-confirm above, and append `· prunable` when any are found. The render offers `/trailhead:prune` for such a map, never auto-prunes;
- the whiteboard as a section, or a link to the `/trailhead:whiteboard` view;
- dynamic counts: untriaged inbox size and whiteboard frontier size.

Count queries, `--json ... --jq 'length'` style:
```bash
# untriaged inbox size: open issues carrying no trailhead:* label (section A of ../trailhead-chart/references/inbox.md), counted
gh issue list --state open --json number,labels \
  --jq '[.[] | select([.labels[].name] | any(startswith("trailhead:")) | not)] | length'
# whiteboard frontier size: the whiteboard frontier query above, counted
gh issue list --label "trailhead:ticket" --label "trailhead:whiteboard" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified" --json number --jq 'length'
# per-map exhaustion pre-filter: open issues scoped to map <n>; count == 0 makes it a candidate (not yet a verdict)
gh issue list --label "trailhead:map-<n>" --state open --json number --jq 'length'
# confirm no fog before flagging a candidate closeable: its body's `## Not yet specified` must be empty
gh issue view <map> --json body --jq .body
# per-map sub-issue cap: total native sub-issues (>=90 near cap, >=100 at cap)
gh api repos/{owner}/{repo}/issues/<map> --jq '.sub_issues_summary.total'
```

**When to refresh the body.** On structural events: a map is charted or exhausted (a map appears or disappears), a whiteboard ticket is born or resolved. And on demand via `/trailhead:dashboard`. NOT on every map-ticket resolve: that churns a pinned issue's notifications, and the native progress bar already tracks map-ticket progress on its own. The whiteboard has no native progress bar, so its ticket birth or close refreshes the dashboard, except a `quick`-born ticket (born and resolved in one session) refreshes at the handoff (Resolve, or pause), not at creation.

## First-use repo setup (do ALL THREE, every chart or adopt, never skip any)
1. Create any missing labels with `gh label create` (all eighteen: `trailhead:map`, `trailhead:codebase`, `trailhead:conventions`, `trailhead:dashboard`, `trailhead:ticket`, the six type labels, `trailhead:blocked`, `trailhead:seed`, `trailhead:out-of-scope`, `trailhead:superseded`, `trailhead:unverified`, `trailhead:fog`, `trailhead:whiteboard`).
2. **Check the label guard is installed**: `gh api repos/{owner}/{repo}/contents/.github/workflows/trailhead-label-guard.yml`; if it's absent (404), install it: **read `teamwork.md` (Trust & provenance → Repo-side enforcement) for the exact steps**. This is part of standing up trailhead in a repo, not an optional extra: *check every time*, so a repo can never end up with the labels but no guard.
3. **Install the commit-msg git hook**: check for `.git/hooks/commit-msg`; if absent, install the shipped host-independent hook so trailhead's commit discipline (Conventional Commits subject, no `Co-Authored-By`) runs on **every** `git commit` regardless of host (the Claude-Code `PreToolUse` guard stays too, defence in depth): **read `teamwork.md` (Trust & provenance → Repo-side enforcement) for the exact steps**. Like the label guard, *check every time*; unlike it, `.git/hooks/` is per-clone local state (untracked), so it is installed, never committed.
