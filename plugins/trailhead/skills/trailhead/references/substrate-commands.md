# Substrate: base `gh` commands + first-use repo setup

The command cookbook for the GitHub Issues substrate. Read this at work time (creating tickets, wiring blockers, querying the frontier) and at chart/adopt (first-use setup). The conceptual model (Element table, State labels, Frontier definition, reconciliation) stays in SKILL.md → **Substrate: GitHub Issues**.

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

## First-use repo setup (do ALL THREE, every chart or adopt, never skip any)
1. Create any missing labels with `gh label create` (all eighteen: `trailhead:map`, `trailhead:codebase`, `trailhead:conventions`, `trailhead:dashboard`, `trailhead:ticket`, the six type labels, `trailhead:blocked`, `trailhead:seed`, `trailhead:out-of-scope`, `trailhead:superseded`, `trailhead:unverified`, `trailhead:fog`, `trailhead:whiteboard`).
2. **Check the label guard is installed**: `gh api repos/{owner}/{repo}/contents/.github/workflows/trailhead-label-guard.yml`; if it's absent (404), install it: **read `references/teamwork.md` (Trust & provenance → Repo-side enforcement) for the exact steps**. This is part of standing up trailhead in a repo, not an optional extra: *check every time*, so a repo can never end up with the labels but no guard.
3. **Install the commit-msg git hook**: check for `.git/hooks/commit-msg`; if absent, install the shipped host-independent hook so trailhead's commit discipline (Conventional Commits subject, no `Co-Authored-By`) runs on **every** `git commit` regardless of host (the Claude-Code `PreToolUse` guard stays too, defence in depth): **read `references/teamwork.md` (Trust & provenance → Repo-side enforcement) for the exact steps**. Like the label guard, *check every time*; unlike it, `.git/hooks/` is per-clone local state (untracked), so it is installed, never committed.
