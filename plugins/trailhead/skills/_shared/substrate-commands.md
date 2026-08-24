# Substrate: `gh` command cookbook + first-use repo setup

The single command reference for every `gh` mechanic the GitHub Issues substrate uses. Cluster skills link here and never re-describe any of it. The conceptual model (Element table, State labels, Frontier definition, reconciliation) stays in `substrate.md` (and its SKILL.md mirror). Read this file at work time (creating tickets, wiring blockers, querying the frontier, refreshing the dashboard) and at chart/adopt (first-use setup).

## Base commands
```bash
# create the map
gh issue create --label "trailhead:map" --title "<destination>" --body-file <body>
# create a child ticket (add trailhead:blocked too if it has an open blocker; add trailhead:map-<map> to scope it to its map)
gh issue create --label "trailhead:ticket,trailhead:build,trailhead:map-<map>" --title "<question/goal>" --body-file <body>
# link the ticket to its map: native sub-issue (structure/UI) + the map label above (the query)
gh api --method POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id=$(gh api repos/{owner}/{repo}/issues/<ticket> --jq .id)
# wire a blocker: native dependency (visual frontier in the UI) + the label (the query)
gh api --method POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id=$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)
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
   gh api --method POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id=$(gh api repos/{owner}/{repo}/issues/<ticket> --jq .id)
   ```
   This is the structure GitHub renders, including the map's progress bar.
3. The map's `trailhead:map-<n>` label on the ticket: the queryable key that scopes the frontier.

Wire all three in the same pass; a ticket carrying only one or two has drifted. A whiteboard ticket has none of the three: no `Parent:` line, no sub-issue edge, no `trailhead:map-<n>` label.

**Blocker (three moves):**
1. A `## Blocked by` line in the ticket body, naming and linking the real blocker ticket.
2. The native dependency:
   ```bash
   gh api --method POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id=$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)
   ```
3. The `trailhead:blocked` label:
   ```bash
   gh issue edit <blocked> --add-label "trailhead:blocked"
   ```

Same-blocker rule: all three must name the SAME blocker ticket, never a superseded parent, a split-origin, or a by-role placeholder ("child A"). Write the prose line and the native dependency from the same id, in the same pass, so they cannot point at different tickets.

Unblock: remove the label the moment the last blocker closes:
```bash
gh issue edit <n> --remove-label "trailhead:blocked"
```
The native edge needs no cleanup; GitHub auto-reflects a closed blocker on its own.

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

**Body generation.** The body holds:
- a link to every open `trailhead:map`, found with `gh issue list --label trailhead:map --state open`. The dashboard only links; GitHub renders each map's sub-issue progress bar natively, so the dashboard does not recompute per-ticket progress itself. **Per open map, additionally run one cheap `0 open scoped issues?` count** (below): a map with zero open scoped issues is **exhausted but still open** (its destination is reached, yet the map issue was never closed), so flag it in the Maps section as `exhausted · closeable`. This is one count query per map, never a per-ticket recompute, so it stays within the dashboard-only-links spirit. The flag is a signal, not an action: the `/trailhead:dashboard` render offers to close such a map, never auto-closes it (the never-close-unprompted rule holds);
- the whiteboard as a section, or a link to the `/trailhead:whiteboard` view;
- dynamic counts: untriaged inbox size and whiteboard frontier size.

Count queries, `--json ... --jq 'length'` style:
```bash
# untriaged inbox size: open issues carrying no trailhead:* label (section A of ../trailhead-chart/references/inbox.md), counted
gh issue list --state open --json number,labels \
  --jq '[.[] | select([.labels[].name] | any(startswith("trailhead:")) | not)] | length'
# whiteboard frontier size: the whiteboard frontier query above, counted
gh issue list --label "trailhead:ticket" --label "trailhead:whiteboard" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified" --json number --jq 'length'
# per-map exhaustion: open issues scoped to map <n>; count == 0 means exhausted-but-open, flag it closeable
gh issue list --label "trailhead:map-<n>" --state open --json number --jq 'length'
```

**When to refresh the body.** On structural events: a map is charted or exhausted (a map appears or disappears), a whiteboard ticket is born or resolved. And on demand via `/trailhead:dashboard`. NOT on every map-ticket resolve: that churns a pinned issue's notifications, and the native progress bar already tracks map-ticket progress on its own. The whiteboard has no native progress bar, so its ticket birth/close does refresh the dashboard.

## First-use repo setup (do ALL THREE, every chart or adopt, never skip any)
1. Create any missing labels with `gh label create` (all eighteen: `trailhead:map`, `trailhead:codebase`, `trailhead:conventions`, `trailhead:dashboard`, `trailhead:ticket`, the six type labels, `trailhead:blocked`, `trailhead:seed`, `trailhead:out-of-scope`, `trailhead:superseded`, `trailhead:unverified`, `trailhead:fog`, `trailhead:whiteboard`).
2. **Check the label guard is installed**: `gh api repos/{owner}/{repo}/contents/.github/workflows/trailhead-label-guard.yml`; if it's absent (404), install it: **read `teamwork.md` (Trust & provenance → Repo-side enforcement) for the exact steps**. This is part of standing up trailhead in a repo, not an optional extra: *check every time*, so a repo can never end up with the labels but no guard.
3. **Install the commit-msg git hook**: check for `.git/hooks/commit-msg`; if absent, install the shipped host-independent hook so trailhead's commit discipline (Conventional Commits subject, no `Co-Authored-By`) runs on **every** `git commit` regardless of host (the Claude-Code `PreToolUse` guard stays too, defence in depth): **read `teamwork.md` (Trust & provenance → Repo-side enforcement) for the exact steps**. Like the label guard, *check every time*; unlike it, `.git/hooks/` is per-clone local state (untracked), so it is installed, never committed.
