---
title: Working as a team
description: Claiming, the shared frontier, isolation, scope, submodules, trust, and capture from CI.
---

Many people (and their agent sessions) share one map and work it concurrently:

- **Claim = assign to yourself.** The claimer owns the ticket end to end and closes it: there is no approver and no one to wait on. On a claim collision the session stops and asks you, rather than resolving it silently.
- **Split** an oversized ticket into children and supersede the original (`/trailhead:split`).
- **Pause/resume** via a `PAUSED` checkpoint comment, so any session can pick a ticket back up.
- **Isolate concurrent sessions with worktrees.** By default (`isolation: auto`) trailhead does this for you: at each ticket's work-start it asks whether you'll run more than one at once and picks the mode by repo shape. To force it eagerly, set `isolation: worktree` in the conventions header, and each executing ticket runs in its own `git worktree` on a `trailhead/t<n>` branch, integrated back to the trunk at Resolve. It implies a branch per ticket even under `git: main` (git won't check the trunk out twice), and it's the right posture for a monorepo (a worktree shares the object store, far cheaper than a second clone). One caveat: a worktree isolates *source* but is a fresh path with no installed deps, so a path-bound package (React Native/Expo, native toolchains, anything tied to a local `node_modules`) won't build from it. For those there's `isolation: clone`: a dedicated per-ticket clone that installs its own deps and builds/UATs like the real app (heavier than a worktree, and the right tool for an Expo/RN submodule). Or keep `isolation: none` and serialize. Otherwise run concurrent sessions in separate clones.
- **A session-ticket marker for your statusline.** When it starts working a ticket, trailhead drops a one-line, gitignored `.trailhead/session-ticket` (`#<n> <title>`) at the working root and clears it at handoff. It's a cheap, offline hint so a statusline (or any tool) can show which ticket this session is on without hitting the tracker; trailhead itself still treats the Issues as the source of truth. It also does more than that: while it's present, the git [commit-msg hook](/docs/hooks#commit-msg-hook) requires every commit to carry a `Refs: #<n>` trailer matching it, so a stale marker would wrongly demand that trailer on unrelated commits; trailhead removes it at handoff. The hook is kept installed and current by a sync run at chart/adopt time and at every `work` and `quick` start.
- **It picks isolation for you by default (`auto`).** With no explicit `isolation:` set (the default is `auto`), at a ticket's work-start trailhead asks whether you'll work more than one at once on this machine this session; if so it uses a `git worktree` (plain repo) or a `clone` (submodule superrepo), otherwise it just works in the current checkout. Your answer is remembered for the working stretch (it lapses after 8 hours idle), so the next ticket reuses it with a one-line note instead of asking again; it asks again if the other tickets assigned to you changed. Nothing is written into the conventions, and you can still force `none`/`worktree`/`clone` explicitly.
- **Gitignored files follow the workspace.** A new worktree or clone has none of the gitignored files the app needs (`.env`, local config). List them in `isolation.copy` and trailhead copies them in right after creating the workspace, never overwriting an existing file (see [Configuration](/docs/configuration)).
- **Stale-base preflight.** At the start of Verify, before a UAT that skips Verify, and at Resolve before integrating, trailhead brings the ticket's branch current with the trunk (fast-forward, rebase or merge) and runs your `preflight.checks`. If the sync rewrote the ticket's commits, the code review is re-run on the new diff, and tests re-run after any sync. It fails closed: a conflict, a dirty tree, an unverified fetch or a failing check stops the ticket for you to decide, and `/trailhead:auto` never resolves a conflict.
- **Scope tickets by path on a monorepo.** A ticket can carry a `Scope:` line naming the package/dir(s) it touches: disjoint scopes parallelize safely, and it scopes build/test and the worktree's commits to the affected package. `/trailhead:adopt` detects a monorepo and proposes both `isolation: worktree` and the `Scope:` convention. Under `isolation: none`, `Scope:` also serializes a shared area: at claim time a session holds off if another in-progress ticket's scope overlaps, so two tickets scoped to the same submodule/package can't run at once (how you keep two sessions off one path-bound app).
- **Git submodules are handled as separate repos.** Work that lands inside a submodule is committed *inside the submodule* (on a branch) and published before a gitlink bump in the parent points at it. Because superproject worktrees share one submodule git dir, a **submodule-bearing repo resolves to `clone`** (under the default `auto`, or by escalating an explicit `worktree`), so each ticket gets independent submodule state; the clone provisions its submodules at setup (`--recurse-submodules`) and Verify checks `git status` inside each touched submodule. A ticket spanning two submodules stays atomic via a single parent commit that bumps both gitlinks together; its `Scope:` names both, and the same submodule counts as overlapping scope, so two tickets on it serialise. `/trailhead:adopt` detects `.gitmodules` and writes the rule into the conventions.
- **State lives on the tickets** (claim, labels, comments; all conflict-free); the map body is a re-readable index, not the source of truth. The durable record of a resolution is the ticket's own comment.
- **Labels are protected from outsiders.** `trailhead:*` labels drive the map, so trailhead trusts a labelled issue only when every `trailhead:*` label on it was applied by a trusted labeller and (for a ticket) it carries a valid `Parent:`. A trusted labeller is `github-actions[bot]`, a login listed in the `TRAILHEAD_LABEL_ALLOWLIST` repo variable, or a collaborator with write access or above: the same set the label guard never strips. An issue whose labeller cannot be checked (the allowlist or a permission lookup failed) is held off the frontier and shown to you, never quarantined on a guess. Anything else is quarantined as `trailhead:unverified`, off the frontier. GitHub already blocks non-write users from labelling; against triage users and automations, trailhead can install the label guard GitHub Action for you into your repo's `.github/workflows/`, where it strips unauthorized `trailhead:*` labels at the source. Installing a workflow needs a token with the `workflow` scope, so trailhead runs `gh auth refresh -s workflow` if the push is rejected. For automations (CI, cron, bots) that open tickets without a chat session, the capture helper (`templates/trailhead-capture.js`) captures a bug, todo, seed or idea with the full label wiring and refuses to run as an identity the guard would strip. On GitHub, the [capture Action](#capture-from-ci) wraps it in a few lines of workflow.
- **Issues opened by others are triaged, not trusted blindly.** `/trailhead:inbox` lists inbound issues (bug reports, requests, questions that aren't yet trailhead tickets, plus quarantined `trailhead:unverified` issues) and integrates the worthwhile ones in place: reframing them as tickets, keeping the reporter's authorship, and applying the labels on adoption. The rest routes to fog, out-of-scope, duplicate, or needs-info.

Several maps at once: a repo can carry more than one live map (parallel milestones or features), each with its own scoped frontier, so two people can drive two efforts on the same repo without stepping on each other, and you can park one map to work another.

## Capture from CI

`ToRvaLDz/trailhead/actions/capture` is a thin composite Action over the capture helper, so a workflow can open a trailhead ticket (a failed build, a nightly check) without a chat session. Every rule (trust, destination, dedupe, secret scan, labels, sub-issue edge, dashboard) stays in the helper; the Action only maps its inputs to the helper's flags. It ships from trailhead 0.17.0; pin a release tag.

```yaml
permissions:
  issues: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # ... your build and test steps ...
      - if: failure()
        uses: ToRvaLDz/trailhead/actions/capture@v0.17.0
        with:
          type: bug
          title: "CI failed on ${{ github.ref_name }}"
          body: "Run: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
          dedupe-key: ci-failure-${{ github.job }}
```

A manual variant works the same way: trigger the job with `workflow_dispatch` and pass `type`, `title` and `body` from `github.event.inputs`.

| Input | Required | Meaning |
|---|---|---|
| `type` | yes | `bug`, `todo`, `idea` or `seed` |
| `title` | yes | issue title |
| `body` / `body-file` | one of | issue body, or a file path (`-` for stdin); not both |
| `map` / `of` | no | file under map `<n>`, or inherit the map of origin ticket `<n>` (bug only); exclusive |
| `trigger` | seed only | the `Trigger:` text |
| `unverified` | no | `true` adds `trailhead:unverified` (not for `idea`) |
| `dedupe-key` | no | idempotency key, 1 to 100 characters of `A-Za-z0-9._:-` (no spaces or `/`) |
| `no-dashboard` | no | `true` skips the whiteboard dashboard refresh |
| `repo` | no | target `owner/name` (default: this repo) |
| `token` | no | token for the helper (default: `github.token`) |

Outputs: `issue`, `url` and `status` (`created`, `existing`, `partial`, `error`, `usage`).

- The default token acts as `github-actions[bot]`, which the label guard trusts; the helper verifies the labeller after the create and fails closed when it cannot confirm a trailhead label.
- A re-run with the same `dedupe-key` returns `existing` and creates nothing.
- `partial` (exit 3: the issue exists but the sub-issue edge failed), `error` and `usage` (exit 2, bad inputs) fail the step; `status` is still set.
- The runner needs bash, node and gh, all present on GitHub-hosted runners; self-hosted runners must provide them.

Next: [Configuration](/docs/configuration) for the `isolation:` and other conventions keys, or [Commands](/docs/commands) for the verbs mentioned above.
