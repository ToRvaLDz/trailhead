<div align="center">

![trailhead](assets/social-preview.png)

# Trailhead

🇬🇧 **English** · 🇮🇹 [Italiano](README.it.md)

[![website](https://img.shields.io/badge/website-trailhead.marcomigozzi.it-3C7A5A?style=flat-square)](https://trailhead.marcomigozzi.it) [![site CI](https://img.shields.io/github/actions/workflow/status/ToRvaLDz/trailhead/site-ci.yml?branch=main&style=flat-square&label=site%20CI)](https://github.com/ToRvaLDz/trailhead/actions/workflows/site-ci.yml) [![npm](https://img.shields.io/npm/v/@marcomigozzi/trailhead?style=flat-square&label=npm&color=CB3837)](https://www.npmjs.com/package/@marcomigozzi/trailhead) [![license](https://img.shields.io/github/license/ToRvaLDz/trailhead?style=flat-square&color=3C7A5A)](LICENSE) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-1E2A54?style=flat-square) ![commands](https://img.shields.io/badge/commands-24%20verbs-0e8a16?style=flat-square) ![guardrails](https://img.shields.io/badge/guardrails-9%20hooks-e8710a?style=flat-square)

</div>

**Start and drive large projects as a map of tickets on GitHub Issues, resolving one at a time until the way to the destination is clear.**

`trailhead` is an orchestrator skill for coding agents, running on [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex CLI](https://developers.openai.com/codex/cli) from a single source. It gives a big, foggy idea a place to begin (a *trailhead*) and a disciplined way to walk it to a working result, with the whole plan living on your issue tracker instead of in scattered local files.

---

## 💡 Why trailhead exists

Two approaches to agent-driven project work each nail one half of the problem:

- **[Wayfinder](https://github.com/mattpocock/skills)** (by Matt Pocock) is brilliant at *starting*. It turns a loose idea into a **shared map of decision tickets on your issue tracker**, named through a proper grilling conversation, with a visible frontier and a "fog of war" for what isn't sharp enough to plan yet. You resolve one decision per session and the map grows outward. What it deliberately doesn't do is *build*: it plans, then hands off.

- **GSD** (the [open-gsd](https://github.com/open-gsd/gsd-core) workflow system) is brilliant at *doing*. Its `discuss → plan → execute → verify` cycle, atomic commits, and zero-friction capture make the actual construction reliable and reviewable. But its state lives in a local `.planning/` tree, separate from where the team can see it.

Working across both, one pattern kept recurring: **use a Wayfinder-style map and onboarding to decide the shape of the work, then a GSD-style engine to build each piece, without ever leaving the issue tracker.** `trailhead` is that pattern made into a set of cohesion-clustered skills over a shared core, its own self-contained take on both ideas rather than a wrapper around either.

> **trailhead is self-contained** in the sense that it has **zero external-plugin dependencies**: trailhead-owned agents and the host's built-ins are fine, and no other skill or plugin is required. Wayfinder and GSD are *inspiration*, not dependencies. Every technique those systems package as a separate skill (grilling, TDD, systematic debugging, codebase mapping, code review) is **built in here as an inline protocol**. trailhead's core invokes no other skill; each engine technique dispatches to **trailhead's own `trailhead-*` agent** (`trailhead-executor`, `trailhead-plan`, `trailhead-research`, `trailhead-code-review`, `trailhead-debug`, plus `trailhead-fix` and `trailhead-codebase-map`), authored once as a committed `agents/trailhead-*.md` file and **projected to each host** (Codex gets `~/.codex/agents/trailhead-*.toml` generated from that same source). These agents are **thin** (identity + tool policy + a config-driven model, with the technique protocol injected at spawn) and run on the host's native subagent toolkit (Claude Code's built-in `Agent` tool, or Codex's `multi_agent` toolkit). The only thing to install is trailhead itself. There is one opt-in exception: hosted mockups. `design: artifacts` uses Claude Code's built-in `Artifact` tool (nothing to install), and `design: stitch` uses the Google Stitch MCP (offered as a one-time install). See [Mockups before code](#-mockups-before-code).

The design choices that fall out of it:

- **Everything lives on GitHub Issues.** The map is the parent issue; each ticket is a child issue; discussion, plan, and verification are *comments*. There is no `.planning/` directory: the repo holds code only, and the plan is always visible to anyone with the repo.
- **Execution happens inside the map.** Unlike pure Wayfinder ("plan, don't do"), build tickets graduate from the fog and are executed as children of the map. The destination is the **working artifact** (a deployed app), not a spec document, though a project can override that and stop at the spec.
- **Hand it a map and come back.** `/trailhead:auto` drains a map or the whiteboard unattended, in up to four parallel slots, and leaves a run report, the tickets that need you, and local commits for you to push. See [Autonomous run](#-autonomous-run-auto).
- **Lean by default.** The heavy machinery (codebase mapping, systematic debugging) runs once where it earns its keep; the per-ticket cycle stays light.

- **Built for teams, because the plan is shared.** The tracker is the single source of truth, so the map is a **shared workspace**, not one person's local file. Many people (and their agents) work it at once, and the mechanics keep them from colliding:
  - **Claiming.** You take a ticket by assigning it to yourself; the assignee *is* the lock. A collision stops you and asks, rather than clobbering someone else's work. Whoever claims a ticket owns it end to end and closes it, no separate approver.
  - **A shared frontier, one ticket per session.** The **frontier** (open, unassigned, unblocked, not paused tickets) is the common queue of what's takeable now; each person picks a different one. Resolving a ticket ends the session, so work stays in reviewable, single-ticket chunks.
  - **Isolation for concurrent sessions on one machine.** Two agents editing one checkout corrupt each other, so the `isolation:` convention (default **`auto`**, which asks at each ticket's work-start whether you'll work more than one at once and then picks the right mode by repo shape) gives each in-flight ticket its own **`git worktree`** (or a full **`clone`** for path-bound apps, or repos with submodules, a worktree can't safely isolate) when you run more than one at once; disjoint `Scope:` lines let non-overlapping work run in parallel and serialise only where it truly overlaps.
  - **Pause, resume, split.** Any ticket can be **paused** with a checkpoint comment and **resumed** later by anyone (once released), or **split** into children when it outgrows a session, with blockers re-pointed so the frontier stays honest.
  - **Several maps at once.** A repo can carry **more than one live map** (parallel milestones or features), each with its own scoped frontier, so two people can drive two efforts on the same repo without stepping on each other, and you can park one map to work another.
  - **Outsiders and trust.** Issues opened by other people flow through an **inbox** that reframes the worthwhile ones into tickets *in place* (keeping the reporter's authorship), while a **trust and provenance** guard quarantines `trailhead:*`-labelled issues from untrusted sources until a maintainer adopts them, backed by a repo-side label-guard workflow.

  The full protocol lives in the **Working as a team** section below.

---

## 📦 Install

> **Runs on Claude Code and Codex CLI.** trailhead is authored once; the installer projects host-native artifacts. On **Claude Code**: a skill + `/trailhead:*` commands + hooks. On **Codex CLI**: a native skill invoked `$trailhead`, one `$trailhead-<verb>` skill per verb for discoverability, and the guardrails as native Codex hooks. Choose the host with `--claude` / `--codex`, or let the installer auto-detect. More hosts can follow (the installer uses a per-host descriptor).

**Prerequisites:** an authenticated [`gh` CLI](https://cli.github.com) (the tracker is GitHub Issues) and a GitHub repo to work in. The npm path also needs Node 18+.

### As a Claude Code plugin (native, managed by `/plugin`)
```
/plugin marketplace add ToRvaLDz/trailhead
/plugin install trailhead@trailhead
```
Update with `/plugin update trailhead`; remove with `/plugin uninstall trailhead`.

### Or via npm (installs into your agent's config dir)
```
npx @marcomigozzi/trailhead              # auto-detect the host (defaults to ~/.claude)
npx @marcomigozzi/trailhead --claude     # Claude Code (~/.claude or $CLAUDE_CONFIG_DIR)
npx @marcomigozzi/trailhead --codex      # Codex CLI ($CODEX_HOME or ~/.codex)
npx @marcomigozzi/trailhead --symlink    # dev install (Claude; symlink to the checkout, edits go live)
npx @marcomigozzi/trailhead --uninstall  # remove everything it added (pair with --claude / --codex)
npx @marcomigozzi/trailhead --dir=<path> # target a specific config dir
```
On **Claude Code** it copies the skill (+ its `references/`), the `/trailhead:*` commands, the hooks (into `hooks/`, registered in `settings.json`) including a SessionStart **update check**, and the templates (label-guard workflow, statusline, the git `commit-msg` hook and the helper scripts the engine runs), idempotently.

On **Codex CLI** (`--codex`) it projects a native Codex skill invoked as **`$trailhead`** (`$trailhead work`, `$trailhead new "idea"`, …), one thin **`$trailhead-<verb>`** skill per verb for discoverability, the eight guardrails as native Codex **hooks** (`~/.codex/hooks.json`, enabling `features.hooks`; the five Bash guards share one process behind a single registration; the search guard is Claude-Code-only and isn't projected to Codex), and per-technique subagent model pins from **`models.codex.*`** into `~/.codex/agents/`. Codex **0.145.0+** is required (the installer gates on `codex --version`). The `artifacts` mockup mode (Claude Code's `Artifact` tool) isn't available on Codex; the cross-host `design: stitch` mode (Google Stitch MCP) is the hosted option there, with local disk as the fallback.

Re-run the install to update, or run **`/trailhead:update`** (Claude) / **`$trailhead update`** (Codex) from inside the agent: it detects how trailhead was installed and installs the newer version where that is safe (a `git pull` for a dev-symlink, an `npx` re-run for npm, or `/plugin update` for the plugin). When a newer version exists, the statusline shows a `⬆ trailhead <version>` flag (Claude).

### After installing
Restart or reload your agent so the commands register, then run **`/trailhead`** to start (smart entry), or `/trailhead:new "<idea>"` to chart a map. **On Codex** the surface is `$trailhead` instead: run **`$trailhead`** for smart entry, `$trailhead new "<idea>"` to chart, or a per-verb `$trailhead-<verb>` skill. Note: once installed, the **commit guard hook runs on every `git commit`** (enforcing Conventional Commits and blocking `Co-Authored-By`); disable the plugin's hooks in settings if you don't want that. Either way trailhead is self-contained: no external skill or plugin is required, no external-plugin preflight, no version drift.

---

## 🗺️ How it works

A **map** is one GitHub issue labelled `trailhead:map`. It's an index, not a store: a Destination, standing Notes, the `Decisions so far`, the `Not yet specified` fog, and what's `Out of scope`.

**What earns a map?** A map is the unit for an effort that is **too big to hold in one session** and carries **open decisions**, not just execution. In practice that's a **milestone** (a release, a version, "v2 of the dashboard"), or a **single feature big enough that you must decide before you can build it**: where the data lives, which library, what the screen actually does. Charting a map names its destination and fans that effort out into many tickets, wired by their dependencies. As the decisions resolve, the fog clears and the build tickets graduate, until the destination is reached.

What does **not** need its own map is a single, defined piece of work with no open questions, small enough to finish in one session. That is just **one ticket**, a direct `build` (or a `todo`): a *work* you take with `/trailhead:work` and resolve in a sitting, no charting required. **Rule of thumb: decisions to make, or too big for one sitting → a map; "just do X" → a single work.** A feature that starts as a lone work but turns out to need decisions gets promoted to its own map (or split); a map whose questions all evaporate collapses back to a handful of works. And a repo can hold **several maps at once** (parallel milestones or features), each with its own frontier, so you can park one and work another.

Each **ticket** is a child issue with a type label and a one-question body. The **frontier** is the set of open, unassigned tickets whose blockers are all closed and that are not paused: what's takeable right now. You claim a ticket by assigning it to yourself, resolve it with the engine for its type, then record the answer as a comment, close it, and gist it back onto the map.

The fog holds only what you cannot phrase yet: a question you can already phrase becomes a ticket at charting, created blocked when it waits on another answer, so it reaches the frontier by itself once that answer lands. As tickets resolve, the fog clears: after each resolution every fog entry is re-read, and the ones now sharp enough to ticket are proposed together, until nothing is left to decide or build and the destination is reached.

A map is scoped to **one** effort, so knowledge that belongs to the *repo* (not to any single map) lives in **repo-scoped anchor issues**, created once and shared by every map (each map's Notes just links them, so nothing is stranded when a map finishes):

- **`trailhead:codebase`**: the distilled codebase map (architecture, stack, conventions, risks, test/build), written once at adopt and refreshed only on major drift.
- **`trailhead:conventions`**: the project's **way of working**, readable by everyone: a small machine-read header the engine obeys (`git: main|pr`, `release: command|auto`, `isolation: auto|none|worktree|clone`) over human prose. `/trailhead:adopt` and `:new` ask for it up front. `isolation: auto` (the default) decides per ticket at work-start: it asks whether you'll work more than one ticket at once and, if so, uses a `git worktree` (plain repo) or a `clone` (submodule superrepo); otherwise it works in the current checkout. `isolation: worktree` gives each executing ticket its own `git worktree` + branch (concurrent sessions on one clone never share a working tree); `isolation: clone` gives it a dedicated clone instead, for path-bound apps a worktree can't build and for submodule-bearing superrepos (where `worktree` is escalated to `clone`).
- **`trailhead:dashboard`**: the pinned index of the whole surface, a link to every open map (with GitHub's native progress bars), the whiteboard, and live counts (inbox, whiteboard frontier). Refreshed when a map is charted or exhausted, when a whiteboard ticket is born or resolved (it has no native progress bar, so the dashboard is the only place it shows; a `quick`-born ticket, worked and resolved in one sitting, refreshes at its handoff or pause, not at creation), and on demand via `/trailhead:dashboard`.

These three fill GitHub's **3 pinned-issue slots**, so a repo's trailhead anchors stay one click away; **maps themselves are never pinned** (they're indexed by the dashboard instead, since the "active" map is per-checkout local state, not a repo-global fact). Project *config* (models, TDD, design…) is separate again, a plain `.trailhead/config.json` file at the repo root, never in an issue.

---

## 🔄 Workflow

**The lifecycle.** Every project walks the same loop:

1. **Start**: `/trailhead:new "<idea>"` (greenfield) or `/trailhead:adopt` (existing code: map the codebase once, then go lean). This *charts the map*: name the destination, then map the frontier breadth-first into the first tickets and the fog.
2. **Work the frontier, one ticket per session**: `/trailhead:work` takes the next takeable ticket (or one you name) and runs the engine for its type: `research` gathers a fact · `decision` diverges options then grills to choose, then opens the build tickets that carry the answer · `prototype` makes a rough artifact to react to · `build` runs discuss → plan → execute → verify · `bug` runs repro → diagnose → fix → verify · `task` is manual plumbing that unblocks a decision. `/trailhead:auto` runs a chosen scope unattended, in up to 4 parallel slots, until the frontier is exhausted or you stop it, parking whatever needs you (a safety-rail action, fog, a human-necessary decision; see below). At a ticket's start, `work` and `quick` show a short brief with a **Proceed / Change something** choice; it is skipped (a one-line note instead) for a ticket you created or just settled in a grilling this session, and `auto` never shows it.
3. **Close & unblock**: resolve the ticket (comment + close), gist it into `Decisions so far`, and drop `trailhead:blocked` from any dependent whose last blocker just closed, graduating it onto the frontier.
4. **Repeat** until the frontier is empty and the fog has cleared: the destination (a working artifact) is reached.

Along the way: **capture** ideas mid-work without derailing, **split** a ticket that grew too big, **pause/resume** across sessions, and let several people work unblocked tickets in parallel.

### 🤖 Autonomous run: `auto`

`/trailhead:auto [map]` drains a map (or the whiteboard, or everything) unattended: it takes ticket after ticket, in 1 to 4 parallel slots, and resolves each with the same engine `/trailhead:work` would run, without handing back to you in between. It never starts on its own: you launch every run.

**`auto` or `work`?** Both resolve tickets; what changes is who stays in the loop. `/trailhead:work` is the interactive mode: one ticket per session, and it stops to ask you along the way (the scope brief, grilling, acceptance). `auto` asks only at the start, then makes the process choices itself and parks for you whatever only you can settle. Use `auto` for well-specified build and bug tickets you don't need to steer; use `work` for decisions, fuzzy tickets, or when you want to drive.

**When you come back** you find the run report in chat (also posted on each touched map), the tickets that need you labelled `trailhead:needs-you` with a `NEEDS YOU` comment, and local commits waiting for you to push: the run never pushes.

While it runs, the chat shows a progress line naming the tickets in the slots and what just resolved or comes next; at the end, the run report. Something like:

```text
auto: slot 1 #42 add social login (verify) | slot 2 #43 session cookie (execute) | resolved #41, next #44

Run report
Stopped:  frontier empty
Resolved: #41, #42, #43, #44
Merged:   #41, #42, #43, #44 into main; local main is 7 commits ahead of origin (pushing is yours)
Remains:  #45 needs you (which providers to support); #46 blocked by #45
```

**Main checkout.** With more than one slot, the run merges each verified slot branch into the local trunk of the main checkout (a fast-forward when possible, else a merge commit), so if you are working in that checkout by hand your branch can move under you. Uncommitted tracked work stays protected: the merge stops on a dirty tree and the ticket is parked needs-you. Untracked files do not trip that check (one in the way of a file the merge brings in still stops it, parked the same way).

- **It asks first, before claiming anything, with no delegate option.** The run scope (one map, the whiteboard, or everything, each with its frontier count, then which map when you pick one map and several are open; `/trailhead:auto <n>` skips only this ask). The parallel slots (1, 2, 3 or 4, 2 proposed; asked under `<n>` too). The external review rounds (as configured, 1, 2, 3 or until convergence, which stops on a round with no progress, hard ceiling 5; at most four options in the structured menu, the full five as a numbered list on a host without one). The review ask is skipped when plan review is off or no independent reviewer CLI is installed (the host's own CLI does not count), and the choice holds for every `build` ticket of the run, overriding `plan_review.rounds` for that run.
- **Order.** Under everything it works one map at a time by ascending map number, the whiteboard last. Inside a scope, the oldest workable ticket first. Blocked tickets are never queued, tickets marked needs-you are skipped, and your own interrupted (paused) tickets in the scope are resumed first.
- **Parallel slots.** With 1 slot, `isolation: auto` and `none` work in the current checkout (an explicit `worktree` or `clone` still applies, and its push or PR is held for you). Above 1 slot, each ticket gets its own `trailhead/t<n>` workspace next to the checkout (`<repo>-t<n>`): a worktree whatever `isolation:` says, an explicit `clone` stays a clone, and a superrepo (submodules) escalates to a clone. It stays one orchestrating session, every engine step runs as a background agent for its slot, and a freed slot takes the next oldest ticket, so tickets of different maps can run together.
- **Local merge.** Under `git: main`, a verified worktree slot branch is merged into the local trunk (fast-forward, else a merge commit), never pushed, one at a time after the stale-base check; then the ticket resolves and its dependents unblock. A sequential run under an explicit `worktree` or `clone`, a run under `git: pr`, and clone slots hold the branch: the ticket is marked needs-you for integration, with its branch and workspace kept and listed.
- **Merge tickets.** When a slot branch conflicts, the merge is aborted (the trunk stays untouched), the branch stays separate with its workspace, and the run opens or updates one **merge ticket** per map (or for the whiteboard) the moment the conflict arises: a needs-you task listing each unmerged branch with its ticket, workspace and conflicting files, plus a suggested merge order (oldest first). You close it once every branch is merged or dropped. A scope with no unmerged branch gets none, and held branches open none. The conflicting ticket stays open, so its dependents stay blocked.
- **Acceptance.** The run drives the agent-performable acceptance steps itself, never picks skip and never fakes a human-only step. Human-only steps go to a **UAT follow-up** (reused if one is open, else a task on the same map or the whiteboard, or a seed when the steps wait on an external trigger) carrying the numbered checklist; then the parent resolves and its dependents unblock. Only the configured `uat.setup` runs, and a failing setup marks the ticket needs-you.
- **Needs you.** A ticket whose next step needs you is parked at once and the run continues: a `decision` convergence, a scope or destination change, an out-of-scope ruling, routing a deferred line, closing an exhausted map, a claim collision, fog to dissolve, a HITL `task` checklist only you can do, a safety-rail action, a stale-base stop, a failing UAT setup, an error looking up the UAT follow-up, or a plan review whose blocking concerns survive the rounds (quoted in full). It gets a `NEEDS YOU` comment saying what you must do, is unassigned, and carries the `trailhead:needs-you` label. It stays on your frontier and map and `/trailhead:work` still offers it, but runs skip it until you clear it (a `work` or `quick` claim clears it, or remove the label by hand).
- **Safety rail (always on, hardcoded).** A release, `git push`, opening a PR, a delete or force, or any other outward-facing action marks the ticket needs-you and the run continues. Local commits and the local slot merge are not rail actions.
- **Failure budget.** A ticket that will not verify gets extra fix rounds (a no-progress rule plus a hardcoded ceiling of 3), then is paused keeping its claim and skipped. One stuck ticket never ends the run.
- **Records, interruption, resume.** Every record (engine comments, commits, UAT follow-ups, `NEEDS YOU` comments, merge tickets, `PAUSED` checkpoints) is written on the tracker when it arises, so a crash loses nothing; the chat progress line, which names the tickets in the slots, is only a mirror. Stop/Esc is the only mid-run halt, and it writes nothing: every in-flight ticket keeps its claim and Esc leaves the same trace as a crash. To resume, run `/trailhead:auto` again: it first recovers an interrupted merge, then resumes paused or crashed tickets in their own workspaces, writing the missing `PAUSED` checkpoint (naming workspace and branch) on each crashed one as it resumes it, then continues. In the same session it reuses the run's choices; a new session asks again. Needs-you tickets are not reconsidered.
- **Run report.** Every run ends with one summary in full in chat, linking the records it summarises: why it stopped, what resolved, what merged (merged tickets, branches left unmerged with their conflicting files, merge tickets, and how many commits the local trunk is ahead of `origin`; pushing is yours), and what remains (needs-you tickets and why, paused or stuck tickets, blocked dependents, UAT follow-ups opened). It is also posted as a comment on each touched map with only that map's part; the whiteboard part stays in chat only, and untouched maps get nothing.

`auto` is orthogonal to `effort` and `models.*` and has no config surface of its own: the asks replace it.

### A worked example: "add social login"

Destination: *users sign in with Google and GitHub, alongside email/password.* Charting fans it into six tickets (one of each type) wired by their dependencies:

```
① research   "OAuth providers + library: Supabase Auth native or Auth.js?"   ← frontier (AFK)
② decision   "approach: Supabase Auth native vs Auth.js custom"              ← blocked by ①
③ task       "register OAuth apps on Google + GitHub, get client id/secret"  ← frontier (HITL)
④ prototype  "how the login screen with social buttons looks"                ← frontier (HITL)
⑤ build      "implement Google + GitHub login"                               ← blocked by ②③④
⑥ bug        (appears after ⑤ ships)
```

Initial frontier = ①③④, three people can start in parallel. Then:

- **① research** → a subagent reads the docs, returns a decision-ready finding, closes → unblocks ②.
- **② decision** → diverge the options, grill to choose native vs custom, record the why.
- **③ task** → the agent hands you a checklist (it needs *your* Google/GitHub accounts); you register the apps, it records where the credentials live.
- **④ prototype** → a rough login screen (on the configured Artifacts canvas), approved before UI code.
- With ②③④ closed, **⑤ build** graduates → discuss → plan → execute (atomic commits, TDD at the auth seams) → verify (tests + code review + acceptance: asked who drives, the agent goes AI-driven and drives the browser through the real login flow).
- After it ships you spot a wrong redirect in prod → `/trailhead:bug --of ⑤ "GitHub redirect goes to localhost"` → a new ticket carrying `Regression of: ⑤`, worked repro → diagnose → fix → verify. ⑤ stays closed.

```
① research ─┐
③ task ─────┼─► ② decision ─┐
④ prototype ┘                ├─► ⑤ build ──(ship)──► ⑥ bug (Regression of: ⑤)
③ task ──────────────────────┘
```

The preparatory types (`research`/`decision`/`prototype`/`task`) unblock the constructive ones (`build`/`bug`); parallelism is real but across sessions on the frontier, not inside one.

### …then a suggestion arrives: inbox → fog → graduation

The app is live, and a user *not on the team* files a plain issue: *"can we add Apple sign-in too?"* No `trailhead:*` label, so it isn't a ticket yet. Here's how an outside voice becomes a first-class ticket on the map, without losing the reporter's authorship:

1. **Inbox**: `/trailhead:inbox` lists it under *New: to triage*. It's in scope but not sharp: web only or native? does it need the paid Apple Developer account? You can't phrase one answerable Question yet, so you don't force a ticket.
2. **Fog**: label it `trailhead:fog` and **keep the issue open as a clarification space**. A comment posts the sharpening questions (async grilling); the reporter and anyone interested refine it in the thread. It's off the frontier but tracked: `gh issue list --label trailhead:fog` is the durable list, and the reporter follows their own issue.
3. **Graduation**: the discussion converges. Next time you run `/trailhead:inbox`, its *Parked fog* section surfaces the thread as recently-active: that's how you notice the fog cleared. Now the Question is phrasable, so you **adopt it in place**: swap `trailhead:fog` for `trailhead:ticket` + a type label, add the `Parent:` line and the `## Question`. Same issue number, same reporter credited, it lands on the frontier, ready for `/trailhead:work`.

```
suggestion issue ──inbox──► 🌫️ fog (kept open, discussed) ──sharpens──► 🎫 ticket on the frontier
                                                                       (same #, reporter still credited)
```

No separate backlog, no lost credit: the map absorbs external suggestions the same way it grows its own, through fog that graduates when it's sharp.

---

## ⌨️ Commands

`trailhead` is user-invoked (it won't fire on its own). The **first word** is the verb; the rest is text or a ticket number. With no verb, `/trailhead` does **smart entry**: it inspects the repo and proposes the right next move.

Every verb is also a namespaced command (`/trailhead:new`, `/trailhead:work`, `/trailhead:bug`, …) so typing `/trailhead` lists them all in the command picker. `/trailhead <verb>` and `/trailhead:<verb>` are equivalent.

### Flow

| Command | What it does |
|---|---|
| `/trailhead` | smart entry: detect state and propose |
| `/trailhead:new [idea]` | chart a new map from a loose idea |
| `/trailhead:adopt` | adopt an existing project (map the codebase once, then go lean) |
| `/trailhead:work [ticket]` | work the next frontier ticket, or the one you name |
| `/trailhead:quick [ticket \| "text"]` | work one ticket whole, never splitting: `"text"` opens a whiteboard ticket off the map; `<n>` takes an existing ticket (a map ticket stays on its map), runs the full engine, grills only if needed |
| `/trailhead:whiteboard` | show the whiteboard: the loose (map-less) tickets and their frontier |
| `/trailhead:inbox [issue]` | triage issues opened by others and integrate the good ones into the map |
| `/trailhead:resume [ticket]` | resume a paused ticket from its `PAUSED` checkpoint |
| `/trailhead:pause [note]` | checkpoint the ticket in play so anyone can resume it |
| `/trailhead:ticket <type> <title>` | open a ticket on the fly (diverges briefly first: a micro-charting act) |
| `/trailhead:split [ticket]` | split an oversized ticket into children, supersede the original |
| `/trailhead:auto [map]` | run a chosen scope (one map, the whiteboard or everything) in up to 4 parallel slots, until exhaustion or a stop; parks what needs you |
| `/trailhead:grill [topic]` | run a standalone grilling session on a decision/topic |
| `/trailhead:map` | show the low-res map (destination, decisions, frontier, fog) |
| `/trailhead:dashboard` | show the repo dashboard: the pinned index of every open map, the whiteboard, and live counts |
| `/trailhead:panel` | open or close the live map panel: the active map's open tickets by state, with a `work` button per frontier ticket (**Claude Code only**: needs the trailhead mod, 2.1.287+) |

### 🖥️ On screen in Claude Code

The trailhead mod (Claude Code 2.1.287+) ships inside the plugin and draws the work beside the conversation. Codex keeps the command hooks and has no panel.

![The map panel docked beside the transcript: open maps, frontier with a work button per ticket, in progress, blocked, and a footer with refresh and close](assets/screenshots/map-panel.png)

The map panel lists the open maps to view, your tickets in progress right under them (in an `In progress` group, from every map and the whiteboard), the tickets an autonomous run parked for you in a `Needs you` group, the frontier with a `work` button per ticket that clears the context and starts the ticket, who holds what (your own ticket is marked `this session`), the pending UAT follow-ups in a `UAT` group (each naming the ticket it tests), the paused ones in a `Paused` group, and what is blocked. A dim line under the Whiteboard row totals the open tickets across every open map plus the whiteboard, the same number `/trailhead:map` states (`at least N` when more open maps exist than the panel reads). The footer has `refresh` and `close`. `/trailhead:panel` toggles it, and it opens by itself once in fullscreen.

![The panel viewing another map, with a viewing and active header and a back to active button](assets/screenshots/map-panel-viewing.png)

A click only views a map, and `back to active` returns to the active one. The active map changes when you work one of its tickets. A `Whiteboard` row above the maps list, with its `N open / M` counts, shows the repo index instead: every open map (a click opens it) and the whiteboard's loose tickets by state, each frontier one with its `work` button; `map` goes back.

![The Burn-down section of the panel: counts line and a chart of open tickets over time](assets/screenshots/burndown.png)

The burn-down shows the open tickets over time, from the map's first ticket to now, with done and removed counted apart.

![The pipeline band above the prompt and the trailhead status entry under it](assets/screenshots/work-state-band.png)

The pipeline band above the prompt and the status entry under it show the ticket in play and its step.

### Capture: zero friction, one confirmation line, resolves nothing

| Command | Lands as | Meaning |
|---|---|---|
| `/trailhead:todo <text>` | a frontier ticket | *I'm doing it*: defined work, now |
| `/trailhead:seed <text>` | a blocked ticket (trigger noted) | *I'll do it when X happens* |
| `/trailhead:idea <text>` | the fog (`Not yet specified`) | *maybe I'll do it*: graduates to a ticket if it sharpens |
| `/trailhead:note <text>` | verbatim text | *remember this*: not necessarily work |
| `/trailhead:bug [--of <ticket>] <text>` | a `bug` ticket | a defect; `--of` records it as a `Regression of:` a closed ticket and files it on that ticket's map (or the whiteboard) without asking |

The four fog/ticket captures form a spectrum of commitment and timing: **note < idea < seed < todo**.

When a map is open, a capture that produces a ticket (`todo`/`bug`/`seed`/a sharp `idea`) asks whether to file it on the **active map** or the **whiteboard**, the home for loose, map-less work that doesn't belong to any map (or isn't worth charting one). With no map open it lands on the whiteboard. Work a whiteboard ticket with **`/trailhead:quick`** (which also opens one from `"text"` and works it in the same sitting), and see them all with `/trailhead:whiteboard`.

### 🧯 Don't get trapped in a map: the whiteboard

Deep in a map, something unrelated surfaces: a bug in another area, a chore, a quick idea you want to act on now. Forcing it onto the map's frontier pollutes the map; charting a whole new map for it is overkill. That is what the **whiteboard** is for, loose map-less work, and two moves keep you from getting stuck:

- **Capture it aside.** A `todo`/`bug`/`seed`/sharp `idea` fired while a map is open asks *map or whiteboard?*. Send it to the whiteboard and it stays off the map: tracked, but out of the way, so the map's frontier keeps meaning "the way to this destination".
- **Do it on the fly.** `/trailhead:quick "<text>"` opens a whiteboard ticket and works it end to end in the same sitting, the full discuss → plan → execute → verify engine (atomic commits, code review, the lot), except it **grills only if needed and never splits**, and skips every map book-keeping step. On a small piece it size-triages and offers to skip the heavy steps (on an explicit yes only; the correctness spine always stays), so `quick` stays fast without setting `effort: lean`. `/trailhead:quick <n>` does the same for a ticket that already exists.

See the whole whiteboard with `/trailhead:whiteboard`. Nothing about the map changes: you just stepped off it, did the thing, and step back on when you're ready.

The three that trip people up are **idea, seed, todo**, so here they are spelled out:

- **`idea`** = *maybe, and not yet clear.* It lands in the **fog** (`Not yet specified`), **not** as a ticket, because you can't even phrase the question sharply yet, so there is nothing to work. It **graduates** into a ticket later, when the frontier reaches it or it simply gets clearer.
- **`seed`** = *yes, but not yet.* It **is** a ticket, but **parked** (`trailhead:blocked`) on a **trigger** you name ("when the public API ships", "when we pass 1k users"). The question is already sharp; what's missing is a **condition**, not clarity. When the trigger fires, it graduates onto the frontier.
- **`todo`** = *yes, now.* Defined work you will just do: it's born a **`build` ticket on the frontier**, takeable immediately.

The two cuts that matter: **idea vs seed** is waiting on *clarity* vs waiting on a *condition* (both land "later", for different reasons); **seed vs todo** is committed *later* vs committed *now*. Below all three sits **`note`** (raw text to remember, maybe never work), and off to the side is **`bug`** (a defect, not a commitment tier). The test for idea vs ticket is always: **can you phrase the question precisely now?** Yes → a ticket (`todo` if takeable, `seed` if gated); no → the fog (`idea`).

### Manage: keep the install and the maps healthy

| Command | What it does |
|---|---|
| `/trailhead:config [get\|set …]` | guided menu setup; `get` prints the effective config, `set <key> <value>` writes one key (see Configuration below) |
| `/trailhead:update` | check for a newer trailhead and install it where that is safe |
| `/trailhead:prune [map]` | reclaim a map's sub-issue slots under GitHub's 100-cap (drops closed/orphan edges, keeps references) |
| `/trailhead:audit [map] [--all]` | audit closed tickets for regressions against today's code, plus duplicate and groupable open ones; read-only until you confirm |

---

## 🎫 Ticket types and their engines

Each ticket carries a type label; each type has its own way of being resolved.

Each type has its own inline engine: no external skill is invoked.

| Type | Produces | Mode | Engine |
|---|---|---|---|
| 🧭 `decision` | a choice | HITL | diverge the options if unclear, then grill to converge on one |
| 🔬 `research` | a fact | AFK | a subagent on a throwaway branch (the only type run in parallel) |
| 🎨 `prototype` | an approved direction | HITL | a rough throwaway artifact to react to; UI screens go through this (disk, an Artifacts canvas, or Stitch) before UI code |
| 🔨 `build` | working code | HITL/AFK | `discuss → plan → execute → verify`: atomic commits, TDD at seams, **[a mockup first](#-mockups-before-code) for user-facing UI** (Prototype technique, gated by `design.approval`), code review + [acceptance testing](#-acceptance-testing-uat) (asks who drives, AI or human, or skip to waive it, then browser-drive or conversational step-by-step UAT) |
| 🐛 `bug` | corrected code | HITL/AFK | `repro → diagnose → fix → verify`; a defect in closed work is a *new* ticket (`Regression of:`), not a reopen |
| 🔧 `task` | an external state change | HITL/AFK | manual work that unblocks a decision (provision access, move data, sign up) |

Two rules of thumb: build tickets **never auto-grill**: on blocking ambiguity the skill stops and asks; and brainstorming (divergence) lives in charting, in `ticket`'s micro-charting, and in a `decision`'s option phase, never in the grilling itself, which only converges.

When trailhead puts a forced choice to you, an advisory one (not a decision that shapes the map) may also offer "let the agent pick (with rationale, then confirm)", and any choice may offer "defer this decision", which parks it as a blocked `decision` ticket or a `seed` until its prerequisite resolves.

---

## 🎨 Mockups before code

Every ticket that changes user-facing UI (a new screen, a redesign, a changed layout) is **mocked up before any UI code is written**. You react to the mockup, approve it, and the build reproduces it faithfully; acceptance testing later checks the result against it. Where the mockup lives is the `design` key:

| `design` | Where the mockup lives | Hosts |
|---|---|---|
| **`disk`** (default) | a throwaway static HTML file next to the code, linked from the ticket | any |
| `artifacts` | a **Design canvas Artifact** on claude.ai: edit it visually, comment on it, export it | Claude Code signed in with a claude.ai account |
| `stitch` | a **Google Stitch** project (or Stitch design system) | Claude Code and Codex |

A UI question that's still open gets **3 structurally different variants** (different layouts, not colours or copy) to pick from, not one take.

### What it looks like with `artifacts`

```text
you       › /trailhead:work                       # ⑤ build: "login screen"
trailhead › This ticket changes UI. Mock it up first?            → yes
trailhead › No canvas for this map yet: pick one, paste a URL, or create one?
you       › create one, "Acme app"
trailhead › Installed your design system "Acme DS" on the canvas.
            Canvas: https://claude.ai/artifact/…  ·  page "#42 Login"
            Artboards: Login-A (split hero) · Login-B (centered card) · Login-C (stepper)
            Which direction?
you       › B, but with the social buttons above the form   # or edit it on the canvas yourself
trailhead › Updated Login-B. Approve?                         → approve
trailhead › Re-read the approved artboard (your live edits included) → planning the build
```

- **One canvas per map**, cached in `design.project`; each ticket gets its own canvas page, each screen (and variant) its own artboard. App screens get a fixed frame (e.g. a 390×844 phone), web pages a fluid one.
- **Your design system on the canvas.** `design.system` (or your account's default) is installed, so the canvas editor offers its colours, type and components instead of look-alikes.
- **Approve with the link in front of you.** Every approval ask carries the canvas URL and the artboard names; the [mockup-link guard](#-hooks) blocks one that doesn't.
- **Edit freely.** Change the canvas directly or leave comments there; on approval trailhead **re-reads** the artboards and builds from *that* version, not from what it last published.
- **`design.approval`**: `explicit` (default) waits for your go-ahead before UI code; `auto` surfaces the mockup and proceeds.

### `stitch` and `disk`

`design: stitch` uses the **Google Stitch MCP**, Google's Gemini-powered UI generator, and is the hosted option that runs on **both Claude Code and Codex**. `design.surface` picks a Stitch project of screens (`canvas`, default) or a shared Stitch design system (`design-system`). If the MCP isn't connected, trailhead offers to install it once (decline and it falls back to disk):

```bash
claude mcp add --scope user --transport http stitch https://stitch.googleapis.com/mcp
```

Where `artifacts` can't run (Codex, or an API-key session), trailhead offers to switch to `stitch` before falling back to disk, and says so: it never silently swaps a hosted mode for a local file.

**Moving from claude.ai/design.** The standalone Claude Design site closes on 2026-12-14 and its designs now live in Claude as Artifacts. A config that still says `design: claude.ai/design` keeps working as `artifacts` (trailhead tells you once and offers to rewrite the key), but a cached claude.ai/design project can't be reused: migrate your design systems from the Artifacts page banner and let trailhead attach a new canvas.

---

## 🧪 Acceptance testing (UAT)

Passing tests prove the code does what the *code* intended; acceptance testing proves it does what *you* wanted. For anything you can see (a new screen, data that now appears, a changed flow), a green suite **does not close the ticket**: Verify runs a UAT too, after tests and code review.

Before it starts, trailhead **checks the base**: it measures how far your working branch is behind the trunk, syncs it (fast-forward, rebase or merge; a conflict aborts and restores), re-runs the tests and runs your `preflight.checks`, and the same check precedes integration; anything it cannot verify stops the ticket. Then it **prepares the environment**: the `uat.setup` steps (start the dev server, boot the emulator; a step whose `check` already passes is skipped) run before the ask below, a failed step stops with a clear reason, and `uat.accounts` names the test logins (only `$ENV` references are stored). With no setup configured it can probe the project and propose one to save. `/trailhead:auto` runs the configured setup only.

1. **It asks who drives.** Before any step runs: **AI-driven**, **human-driven** or **skip**. It waits for a clear answer (silence re-asks). If no step is something the agent can do this session (a device it can't reach, credentials it doesn't hold, a judgement of feel or sound), it drops the AI-driven option and asks **human-driven** or **skip**, telling you why in one line. **Skip is a waiver, not a deferral**: you forgo acceptance, the `VERIFY` comment records it as `waived by the user (unconfirmed)`, never as a pass, and no follow-up is opened. The agent never picks it for you, not even under `/trailhead:auto`.
2. **AI-driven: it drives the app itself.** For a web app it finds the target URL on its own (a running dev server, the `dev` script, the framework's configured port), proposes it for you to confirm, then navigates, fills, clicks and asserts what's on screen, with a **screenshot as evidence** in the ticket's `VERIFY` comment. **Beyond the browser, it drives whatever device the session can reach**: a phone or emulator over `adb`, an iOS simulator, a smart TV, a desktop app, through the commands and tools you have connected (a device MCP, computer use, the platform's CLI). Only the steps it truly can't do come back to you, one at a time.
3. **Human-driven, or what the agent can't reach: a guided walkthrough.** A device that isn't connected, an account it doesn't hold, a call on feel or sound: trailhead walks you through it **one step at a time in the chat** (what to do, where to tap, what you should see), waits for what you actually saw, then moves on. Never a checklist dumped on you to self-serve.
4. **Against the approved mockup.** When the ticket had one, the built screen is checked against it **element by element and state by state** (layout, spacing, colour, type, copy; empty, loading, error, disabled…), from the re-read mockup, never from memory. An unforced deviation is a finding, not "close enough".
5. **Failures become tickets on the spot.** A failed step records expected vs. seen and opens a `bug` follow-up (or a fix on this ticket) right away, then asks whether to carry on.
6. **Nothing slips through as "done".** If the UAT can't run now (the device isn't at hand, the backend isn't deployed), trailhead asks: run it now, or open a follow-up ticket, linked back with a `UAT of:` line and tagged with the `trailhead:uat` label so every pending UAT is findable by one label, that carries the full checklist. A user-facing ticket never closes on a UAT nobody ran unless you explicitly waive it, recorded as unconfirmed.

```text
trailhead › Tests and review are green. Who drives the UAT: AI or you?   → AI
trailhead › Acceptance will run against http://localhost:5173, correct?   → yes
trailhead › ✓ Sign in with GitHub → lands on /dashboard        (screenshot)
            ✓ Login-B vs. the build: 14/14 elements, 4/4 states match
            ✓ Android app on the connected phone (adb): GitHub sign-in → home  (screenshot)
            ? Step 6 is the haptic on "Signed in": does it buzz once, softly?
```

Config: `acceptance.browser` (`auto` default, `on`, `off`) governs browser driving; `off` keeps AI-driven checks via commands and the suite, and still asks who drives. `testing.webapp` / `testing.url` say whether the app is browser-drivable and where. Under `/trailhead:auto`, it goes AI-driven; steps only you can do are never faked: they go to a UAT follow-up carrying the checklist, and the parent ticket resolves; `/trailhead:auto` never picks skip.

---

## 🏷️ Labels

Everything the map needs is expressed as GitHub labels, so state is queryable in the tracker UI:

- **Structural:** `trailhead:map`, `trailhead:ticket`
- **Repo-scoped anchors (one each per repo, pinned):** `trailhead:codebase` 🧱 (the distilled codebase map), `trailhead:conventions` 📜 (the way of working), `trailhead:dashboard` 📊 (the pinned index of maps + whiteboard + counts); each title carries its icon (like the map's 🗺) so the pinned anchors stand apart at a glance
- **Type (one per ticket):** 🧭 `trailhead:decision` · 🔬 `research` · 🎨 `prototype` · 🔨 `build` · 🐛 `bug` · 🔧 `task`
- **State:** `trailhead:blocked` (has an open blocker) · `seed` (parked on a trigger) · `out-of-scope` (closed, beyond the destination) · `superseded` (closed, split into children) · `paused` (checkpointed, off the frontier) · `needs-you` (parked by an autonomous run for you: runs skip it, it stays on your frontier) · `unverified` (quarantined until a maintainer adopts it) · `fog` (kept open for clarification)
- **Container:** `trailhead:whiteboard` (a loose, map-less ticket, off every map's frontier, on the whiteboard's own)
- **Marker:** `trailhead:uat` (a pending UAT follow-up; never a frontier filter) · `trailhead:map-<n>` (scopes a ticket to its map)

The **frontier** is then a single query (open, unassigned, not `trailhead:blocked`, not paused), no body-parsing needed.

## 👥 Working as a team

Many people (and their agent sessions) share one map and work it concurrently:

- **Claim = assign to yourself.** The claimer owns the ticket end to end and closes it: there is no approver and no one to wait on. On a claim collision the session stops and asks you, rather than resolving it silently.
- **Split** an oversized ticket into children and supersede the original (`/trailhead:split`).
- **Pause/resume** via a `PAUSED` checkpoint comment and a `trailhead:paused` label (added by pause, removed by resume), so any session can pick a ticket back up. Paused tickets are listed under a `Paused` group in the map, whiteboard and dashboard views.
- **Isolate concurrent sessions with worktrees.** By default (`isolation: auto`) trailhead does this for you: at each ticket's work-start it asks whether you'll run more than one at once and picks the mode by repo shape. To force it eagerly, set `isolation: worktree` in the conventions header, and each executing ticket runs in its own `git worktree` on a `trailhead/t<n>` branch, integrated back to the trunk at Resolve. It implies a branch per ticket even under `git: main` (git won't check the trunk out twice), and it is the right posture for a **monorepo** (a worktree shares the object store, far cheaper than a second clone). One caveat: a worktree isolates *source* but is a fresh path with no installed deps, so a **path-bound package** (React Native/Expo, native toolchains, anything tied to a local `node_modules`) won't build from it. For those there's **`isolation: clone`**: a dedicated per-ticket clone that installs its own deps and builds/UATs like the real app (heavier than a worktree, and the right tool for an Expo/RN submodule). Or keep `isolation: none` and serialize. Otherwise run concurrent sessions in separate clones. A fresh worktree or clone has no `.env`: list the gitignored files it needs under `isolation.copy` in `.trailhead/config.json` and trailhead copies them in right after creating the workspace, never overwriting (see Configuration).
- **A session-ticket marker for your statusline.** When it starts working a ticket, trailhead drops a one-line, gitignored `.trailhead/session-ticket` (`#<n> <title>`) at the working root and clears it at handoff. It's a cheap, offline hint so a statusline (or any tool) can show *which ticket this session is on* without hitting the tracker; trailhead itself still treats the Issues as the source of truth. It also does more than that: while it's present, the git commit-msg hook requires every commit to carry a `Refs: #<n>` trailer matching it.
- **It picks isolation for you by default (`auto`).** With no explicit `isolation:` set (the default is `auto`), at a ticket's work-start trailhead asks whether you'll work more than one at once on this machine this session; if so it uses a `git worktree` (plain repo) or a `clone` (submodule superrepo), otherwise it just works in the current checkout. Nothing is written into the conventions: the answer is remembered on this machine in the gitignored `.trailhead/isolation-answer.json` and reused, with a one-line note, while your other assigned tickets stay the same and the last work-start was under 8 hours ago; a change or an expired record re-asks. You can still force `none`/`worktree`/`clone` explicitly, and `/trailhead:auto` and explicit modes never use the remembered answer.
- **Scope tickets by path on a monorepo.** A ticket can carry a `Scope:` line naming the package/dir(s) it touches: disjoint scopes parallelize safely, and it scopes build/test and the worktree's commits to the affected package. `/trailhead:adopt` detects a monorepo and proposes both `isolation: worktree` and the `Scope:` convention. Under `isolation: none`, `Scope:` also **serializes** a shared area: at claim time a session holds off if another in-progress ticket's scope overlaps, so two tickets scoped to the same submodule/package can't run at once (how you keep two sessions off one path-bound app).
- **Git submodules are handled as separate repos.** Work that lands inside a submodule is committed *inside the submodule* (on a branch) and published before a gitlink bump in the parent points at it. Because superproject worktrees share one submodule git dir, a **submodule-bearing repo resolves to `clone`** (under the default `auto`, or by escalating an explicit `worktree`), so each ticket gets independent submodule state; the clone provisions its submodules at setup (`--recurse-submodules`) and Verify checks `git status` inside each touched submodule. A ticket spanning two submodules stays atomic via a single parent commit that bumps both gitlinks together; its `Scope:` names both, and the same submodule counts as overlapping scope, so two tickets on it serialise. `/trailhead:adopt` detects `.gitmodules` and writes the rule into the conventions.
- **State lives on the tickets** (claim, labels, comments; all conflict-free); the map body is a re-readable index, not the source of truth. The durable record of a resolution is the ticket's own comment.
- **Labels are protected from outsiders.** `trailhead:*` labels drive the map, so trailhead trusts a labelled issue only when a write-access collaborator applied the label and (for a ticket) it carries a valid `Parent:`. Anything else is quarantined as `trailhead:unverified`, off the frontier. GitHub already blocks non-write users from labelling; against triage users and automations, trailhead can **install the label guard GitHub Action for you** (from `templates/trailhead-label-guard.yml`) into your repo's `.github/workflows/`, where it strips unauthorized `trailhead:*` labels at the source. Installing a workflow needs a token with the `workflow` scope, so trailhead runs `gh auth refresh -s workflow` if the push is rejected.
- **Issues opened by others are triaged, not trusted blindly.** `/trailhead:inbox` lists inbound issues (bug reports, requests, questions that aren't yet trailhead tickets) and integrates the worthwhile ones **in place**: reframing them as tickets, keeping the reporter's authorship, and applying the labels on adoption. The rest routes to fog, out-of-scope, duplicate, or needs-info.

## ✅ Keeping tickets honest

A ticket is one answerable Question, sized to one session, so you never grow it in flight. When new scope surfaces while you're working (testing especially sparks ideas), you decide per idea: small and part of the same Question → just do it; balloons the ticket past one session → **split** it; separate work or a follow-up → **capture** it (`idea`/`todo`/`ticket`/`bug`) and keep going. Extras never become silent lines inside the ticket you're on.

Tickets that spin off from other work carry a lineage pointer in their body, so the map stays traceable:

| Pointer | Meaning |
|---|---|
| `Split from:` | a child of a ticket that was split |
| `Regression of:` | a bug in the work of a closed ticket |
| `Surfaced from:` | an idea/ticket that came up while working another ticket |

---

## ⚙️ Configuration

Three layers: **nearest wins**, key by key (a key unset at one layer inherits the next):

- **Project**: a `.trailhead/config.json` file at the repo root: overrides for this project, committed so a team shares one config. Config lives in a plain file, **never in the map issue**; it's yours to change at any time.
- **Global**: `trailhead/config.json` in your host's config directory: `$CLAUDE_CONFIG_DIR` (default `~/.claude`) on Claude Code, `$CODEX_HOME` (default `~/.codex`) on Codex. Your standing defaults across every project.
- **Defaults**: the built-in values.

`/trailhead:config` runs a **guided, menu-driven setup**: pick the scope, then walk each setting (⚙️ way of working (git · release · isolation) · 🌐 ticket language · 🧠 models (a High / Balanced / Low profile, or Manual) · 🎨 design + approval · 🧪 TDD · ⚖️ effort · 🖥️ acceptance testing (browser, UAT setup, a test account) · 🧑‍⚖️ plan review · 📊 statusline) as an icon-labelled menu; no hand-editing JSON. Every step is asked (none skipped), and **plan and execute models are always two separate, version-pinned choices**. `config get` prints the effective merged config; `config set <key> <value>` writes one key.

`/trailhead:prune [map]` reclaims a map's sub-issue slots under GitHub's 100-cap (drops closed/orphan edges, keeps every reference). Offered automatically when a map is near or at the cap, and runnable on demand.

`/trailhead:audit [map] [--all]` hunts regressions: it checks that the tickets closed since the last audit are still true against the current code. Code a ticket's commits left untouched is classed unchanged with no agent (a fast, deterministic git check that relies on the `Refs: #<n>` commit trailers), decisions, research, tasks and prototypes get a light inline check, and a full verification agent runs only where the code changed or the fast path cannot decide (no `Refs:` commits, for example). Each ticket is classed implemented, unchanged, evolved (a later ticket changed it on purpose, listed with no proposal), implemented wrong, or not implemented. It also flags decisions closed with no build ticket carrying their answer. It then compares the open ones for duplicates and groupable clusters. It is read-only until you confirm: every fix (a regression bug, a reopen, the missing build tickets of a decision, a duplicate close, a supersede-and-merge) is a proposal applied only on an explicit yes. `--all` re-audits every closed ticket.

The **📊 statusline** step offers to install trailhead's Claude Code status bar: one line with **model · project · branch · plan usage (`5h %` · reset · `7d %`) · a context-window bar**, plus a **second line with the active ticket** (`▸ #N Title`) whenever you're working one, and a `⬆ trailhead <version>` flag when a newer trailhead is available (run `/trailhead:update`). The project is always the main repo's name even from an isolated checkout, and the branch carries a `(WT)` tag in a worktree or `(C)` in a per-ticket clone (nothing on the original checkout). It's a global Claude Code setting; if you already run a statusline (e.g. `ccstatusline`) the setup asks before replacing it, and the script also exposes `--ticket-only` / `--context-only` / `--usage-only` segments to slot into an existing tool.

**First-use offer (once per project).** You don't have to seek this out: the first time you set a project up (at the end of `/trailhead:new`/`:adopt`, or on a bare `/trailhead` when a map exists but no config does) trailhead offers to run the guided setup, or to continue on defaults. It asks **only once**: configuring writes `.trailhead/config.json`, and "continue on defaults" writes an empty `{}`. Once that file exists it's never offered again, and it never interrupts mid-ticket.

| Key | Values (default **bold**) | Effect |
|---|---|---|
| `ticket.language` | an ISO 639-1 code (**`en`**) | the language trailhead **writes** its GitHub prose & commit descriptions in, decoupled from the language it converses in |
| `models.{plan,execute,research,review,debug,verify,codebase-map,grill}` | a full **versioned** model id (**Balanced-profile default**; `inherit session` is an explicit choice) | which model runs each activity; `plan` and `execute` are always set separately |
| `models.codex.{plan,execute,research,review,debug,verify,codebase-map,grill}` | an OpenAI model id, or `{model, effort}` (**inherit session**) | the same per-activity split on Codex, independent of `models.*` (Claude ids); re-run the installer to project it into `~/.codex/agents/` |
| `design` | **`disk`** \| `artifacts` \| `stitch` | where UI mockups go: local throwaway HTML, a Design canvas **Artifact** on claude.ai (Claude Code only), or Google Stitch (cross-host, via the Stitch MCP). The legacy `claude.ai/design` value is read as `artifacts` |
| `design.project` | canvas Artifact URL / Stitch project id | `artifacts` and `stitch` only: the canvas or Stitch project the mockups land on; set at the first UI screen (pick, paste or create), not by hand. A leftover claude.ai/design project is not reused |
| `design.surface` | **`canvas`** \| `design-system` | `stitch` only: a Stitch project of screens (default) or a shared Stitch design system |
| `design.system` | Design System Artifact URL | `artifacts` only: the design system installed on the mockup canvas (asked at the first screen if unset) |
| `design.approval` | **`explicit`** \| `auto` | wait for mockup approval before UI code, or proceed without blocking |
| `tdd` | **`seams`** \| `on` \| `off` | how the `build` engine tests |
| `acceptance.browser` | **`auto`** \| `on` \| `off` | drive the browser in Verify (after asking who drives, AI or human, or skip); `off` still runs AI-driven checks via commands, and walks you through a conversational UAT for anything only you can do (step by step in chat, not a checklist to self-serve) |
| `testing.webapp` / `testing.url` | bool / URL | is it browser-drivable, and where |
| `plan_review` | **`off`** \| `on` \| CLI list | send `build` PLANs to external AI CLIs (Gemini, Codex, …) for a second opinion and converge on their concerns |
| `plan_review.rounds` | integer (**`2`**) | max converge-and-re-review rounds |
| `code_review.rounds` | integer (**`2`**) | max fix-and-re-review rounds in Code review before its boundary HITL checkpoint |
| `effort` | **`standard`** \| `lean` | how hard the `build`/`bug` engine works a change: `standard` runs every step, `lean` size-triages small changes and offers to skip the heavy ones (plan pass, TDD, cross-AI review, full code review, goal-backward verify). Governs `build`/`bug` only: `quick` always size-triages regardless of this key |
| `isolation.copy` | array of repo-relative paths (**unset**) | gitignored files and directories (`.env`, `.npmrc`, local config) copied from the main checkout into every new `worktree`/`clone` workspace, never overwriting; unsafe paths (absolute, `..`, `.git`) are rejected. When unset, trailhead suggests the `.env` files that have a tracked `*.example` sibling |
| `preflight.checks` | array of shell commands (**unset**) | your own project checks, run by the base preflight before UAT and before integration; a non-zero exit stops the ticket (e.g. a check for duplicate migration timestamps) |
| `uat.setup` | array of `{name, run, check?, note?}` (**unset**) | ordered setup steps run at every UAT start, before the drive-mode ask (start the dev server, boot the emulator); a passing `check` skips a step; `[]` means no setup needed |
| `uat.accounts` | object of `role: {user, secret}` (**unset**) | named test accounts for UAT; `secret` is always a `$ENV` reference, never a value, so the committed config stays generic (the guided setup asks for the variable name only) |

**Models.** Each key runs its activity as a **subagent** on the model you name, so the whole per-activity split applies within a single work session, whatever model that session runs on:

- `plan` and `execute` are the build/bug engine's steps. Execute is a subagent too, and it commits to `main`.
- `research`, `review`, `debug`, `verify` (the goal-backward Verify check), and the codebase-map fan-out each run on their own key.
- `grill` runs the Grilling rounds on the read-only `trailhead-grill` subagent; unset, it uses the same model as `plan`, and an existing config with no `grill` key simply grills on its `plan` model. The session still asks you each question and keeps the answers.

Choose `plan` and `execute` separately, each by **full versioned id** (never a bare `opus` or `sonnet`). A key left unset uses its Balanced-profile default, and one equal to the session model simply runs inline; set `inherit session` to use the session model. On Codex, an unset `models.codex.grill` follows `models.codex.plan` when that is pinned (re-run the installer to project it), else inherits the session model; a pin equal to the session model runs inline. A profile never writes a `grill` entry, so it keeps following `plan`.

The **main session stays the orchestrator**. It holds the interactive moments (a build's Discuss, and Verify's acceptance/UAT) and it does charting and ticket-writing on its own model; for grilling it relays each question from `trailhead-grill` and asks you itself. No key governs ticket quality, so run charting sessions on your strong model.

Example config file (the same shape works for the project `.trailhead/config.json` and the global `trailhead/config.json` in your config directory):

```json
{ "ticket": { "language": "en" }, "models": { "plan": "claude-opus-5-5", "execute": "claude-sonnet-5-5" }, "tdd": "seams", "acceptance": { "browser": "auto" } }
```

**Design mockups and acceptance testing.** How the `design.*` keys play out (canvas, design system, approval, moving from claude.ai/design) is in [Mockups before code](#-mockups-before-code); how `acceptance.browser` and `testing.*` drive Verify is in [Acceptance testing](#-acceptance-testing-uat).

**Nested or flat.** The list keys above (`isolation.copy`, `preflight.checks`, `uat.setup`, `uat.accounts`) can be written nested (`{"uat": {"setup": [...]}}`) or flat (`"uat.setup": [...]`); if a file has both, the nested form wins with a warning, and a project value replaces the global one as a whole (lists are not merged). `git`, `release` and the isolation *mode* stay in the conventions header; only `isolation.copy` lives in `config.json`.

---

## 🪝 Hooks

Beyond the skill's instructions, trailhead ships nine of its own hooks (in `hooks/`, self-contained via `${CLAUDE_PLUGIN_ROOT}`) that *enforce* the parts of the discipline the model shouldn't be trusted to remember:

- **Commit guard** (`PreToolUse` on `git commit`): hard-blocks a commit whose subject isn't [Conventional Commits](https://www.conventionalcommits.org), and hard-blocks any `Co-Authored-By` trailer. This mirrors GSD's commit validation.
- **Secret guard** (`PreToolUse` on `gh` issue/PR writes): trailhead posts a lot to the tracker (ticket bodies, engine comments, codebase/conventions issues, resolutions). This scans what a `gh issue`/`gh pr`/`gh api` write is about to post (the inline `--body`, a heredoc, or a `--body-file`) and **hard-blocks** it if it matches a credential pattern (private keys, GitHub/AWS/OpenAI/Slack/Google/Stripe tokens, JWTs, or a hardcoded `password`/`secret`/`token=…`). The block is a **clean-and-retry cue, not a dead end**: trailhead redacts the flagged value in place (`<REDACTED>` or an env-var reference) and re-posts automatically, so the cleaned content still lands: the secret just never reaches the tracker. It stays a fail-safe *block* rather than a silent auto-rewrite on purpose: a block never leaks, whereas a redaction that quietly failed to apply would. It never scans reads, only outbound writes.
- **Install guard** (`PreToolUse` on package installs): a slopsquatting barrier. It hard-blocks a named public-registry install (npm / PyPI / crates.io / Go / RubyGems) until the package is vetted (typosquat similarity to popular names, age / first-seen date, download counts, repository metadata present and matching); once vetted, re-run the exact command prefixed with `TRAILHEAD_VERIFIED_INSTALL=1` to proceed. The Execute / Fix engine carries the same block-and-ask. It reads commands the way a shell does: text inside quotes or a heredoc (an `echo`, a commit message) is not an install, lockfile installs pass, and wrappers such as `sudo`, `time`, `env` or `xargs` are seen through.
- **Search guard** (`PreToolUse` on `Bash`): structural backstop for the search-command-hygiene rule (never `cd` then read/search a relative path). It hard-blocks a single Bash command that both changes directory (`cd`/`pushd`/`env -C`) and, in a joined or later statement, reads/searches a relative path (`grep`/`rg`/`ag`/`cat`/`head`/`tail`/`wc`/`nl`/`sed`/`awk`/`less`/`more`, or `git grep`/`log`/`show`/`diff` without a `-C`), so the shape that trips a `Read()` deny rule under bypass permissions (falling back to a manual approval prompt instead of running headless) never runs at all, rather than merely being discouraged in the agent's own prose. Redirection targets (`2>/dev/null`) are not treated as reads, and a `cd` to the session's own directory does not arm it. Claude Code only; not projected to Codex, which has no such `Read()` deny rule.
- **Body guard** (`PreToolUse` on `gh` issue/PR body writes): hard-blocks a `gh issue edit` / `gh pr edit` / `gh api` write that would set an issue body to empty or whitespace-only, so a read-modify-write whose read returned an empty/degraded body (e.g. a transient HTTP 5xx on `gh issue view --json body`) can never clobber the existing body.
- **Labels guard** (`PreToolUse` on `gh issue create`): checks the label set of a ticket at the create call. A create carrying any `trailhead:*` label must carry the whole ticket shape: `trailhead:ticket`, exactly one type (`decision`, `research`, `prototype`, `build`, `bug`, `task`) and exactly one destination (one `trailhead:map-<n>` or `trailhead:whiteboard`, never both, never two maps); the block names what is missing or conflicting and asks to retry with every label in the same create call, never a later `--add-label`. Non-ticket issues (`trailhead:map`, `dashboard`, `codebase`, `conventions`, `fog`, `unverified`) are exempt. A create with no `trailhead:*` label at all is blocked too, but only inside a trailhead repo (the working directory sits in a git work tree whose top level has `.trailhead/`) and not when aimed at another repo with `-R`/`--repo`; a deliberate non-trailhead issue opts out by prefixing the command with `TRAILHEAD_PLAIN_ISSUE=1`. A label value the guard cannot resolve statically (`$VAR`, backticks, `$(...)`) is never blocked.
- **Secret-read guard** (`PreToolUse` on `Read|Bash`): denies reads of `.env`/`.env.*`/`.secrets`, whether via the Read tool or a Bash command (a file operand, an option value, or a `<` redirect target), including the `-f`/`--file` script or pattern file of `grep`, `sed`, and `awk`. A command wrapper (`env`, `nice`, `timeout`, `nohup`, `sudo`, `stdbuf`, `time`, `setsid`, `doas`) in front of a nested shell (`bash -c`) or `eval` next to a secret-looking path is blocked too, since the wrapper would hide the inner command. This is a hook `deny` decision rather than a `Read()` permission rule, so secrets stay unreadable without arming Claude Code 2.1.259's `cd-compound-read` approval prompt.
- **Mockup-link guard** (`PreToolUse` on `AskUserQuestion`): structural backstop for the Prototype rule that a mockup approval ask carries the mockup's link. It hard-blocks an `AskUserQuestion` that asks to approve a mockup (or pick between mockup variants) when neither the reply text right before it nor the approval question itself holds a URL or file path (when the current message is not yet in the transcript, the guard cannot judge and allows), so the agent puts the clickable link in the message before asking again. On Codex, which has no `AskUserQuestion` tool and asks as a plain-text numbered list, its twin `mockup-link-stop` runs on `Stop`: when the final reply asks for that approval without a link, Codex continues the turn so the agent rewrites the ask with it.
- **Issue injection scanner** (`PostToolUse` on `gh` reads): trailhead reads issue/PR/comment text written by anyone with repo access, i.e. untrusted input. When that text contains prompt-injection phrases, the hook injects an advisory reminding the agent to treat it as data, never as commands. Advisory only: it never blocks.

The commit, secret, install, search, body, and labels guards run in **one process**: a single `trailhead-bash-guards.js` registration evaluates them in that order, so a Bash call pays one node start-up instead of six (three hook processes per Bash call in all: the merged hook, the secret-read guard, and the injection scanner). They remain six distinct guards with unchanged verdicts; the first block wins, and a guard that errors allows on its own without stopping the others. A guard whose module is missing or broken is skipped too, but never silently: the hook tells the session which guard did not check the command, so a partial install shows up. On Codex the same hook is registered with `--guards=commit,secret,install,body,labels`, since there is no search guard there.

The secret, body, and secret-read guards also **fail closed on shell constructs they cannot interpret with certainty** (`eval`, `source` / `.`, a bash 5.3 `${ cmd; }`, `printf -v`, a function definition, an alias, a quoted `gh api` body key, a backslash-newline inside a word): when one can hide or precede a write (or sits next to a secret path), the command is blocked with a "rewrite it in a simple form" message instead of being emulated; the same constructs with no write or secret nearby pass.

Alongside them trailhead installs a git **`commit-msg` hook** (a POSIX `sh` wrapper, so it also works in `"type": "module"` repos) that enforces the same commit rules on every host, plus the `Refs: #<n>` trailer while a session ticket is active. If it cannot run (script missing, no `node`) it prints `trailhead: commit-msg hook inactive (<reason>); commit rules not enforced.` to stderr and lets the commit through; an installed hook is upgraded at the next ticket start.

All nine are crash-safe (any error → allow) and active whenever the plugin is installed. The commit, secret, install, search, body, and secret-read guards therefore apply in **every** repo, not only trailhead projects: intentional, since conventional commits, no `Co-Authored-By`, no leaked secrets, no unvetted installs, no `cd`-then-relative-read, no clobbered issue bodies, and no readable `.env`/`.secrets` are trailhead's standing rules. To opt out, disable the plugin's hooks in your Claude Code settings.

---

## 🙏 Acknowledgements

`trailhead` stands on the shoulders of two bodies of work. It is an original, self-contained methodology **inspired by** them. It does not copy or redistribute their code, and it invokes none of their skills; it reimplements the ideas as its own inline protocols:

- **[Matt Pocock](https://www.aihero.dev)**: for **Wayfinder**, whose map / frontier / fog-of-war model is the backbone of trailhead's planning half, and whose `grilling`, `domain-modeling`, `prototype`, `research`, and `tdd` skills shaped trailhead's inline techniques. See [`mattpocock/skills`](https://github.com/mattpocock/skills).
- **The [open-gsd](https://github.com/open-gsd/gsd-core) team**: for **GSD**, whose `discuss → plan → execute → verify` cycle, capture model, codebase mapping, and systematic debugging are the engine of trailhead's building half.

Thank you. If you like the ideas here, go star and use the originals: they go far deeper than trailhead's compact protocols.

---

## 📄 License

MIT © Marco Migozzi ([@ToRvaLDz](https://github.com/ToRvaLDz))
