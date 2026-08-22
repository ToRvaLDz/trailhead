<div align="center">

# Trailhead

🇬🇧 **English** · 🇮🇹 [Italiano](README.it.md)

[![npm](https://img.shields.io/npm/v/@marcomigozzi/trailhead?style=flat-square&label=npm&color=CB3837)](https://www.npmjs.com/package/@marcomigozzi/trailhead) [![license](https://img.shields.io/github/license/ToRvaLDz/trailhead?style=flat-square&color=3C7A5A)](LICENSE) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-1E2A54?style=flat-square) ![tracker](https://img.shields.io/badge/tracker-GitHub%20Issues-6f42c1?style=flat-square) ![commands](https://img.shields.io/badge/commands-20%20verbs-0e8a16?style=flat-square) ![guardrails](https://img.shields.io/badge/guardrails-4%20hooks-e8710a?style=flat-square)

</div>

**Start and drive large projects as a map of tickets on GitHub Issues, resolving one at a time until the way to the destination is clear.**

`trailhead` is an orchestrator skill for coding agents, running on [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex CLI](https://developers.openai.com/codex/cli) from a single source. It gives a big, foggy idea a place to begin (a *trailhead*) and a disciplined way to walk it to a working result, with the whole plan living on your issue tracker instead of in scattered local files.

---

## 💡 Why trailhead exists

Two approaches to agent-driven project work each nail one half of the problem:

- **[Wayfinder](https://github.com/mattpocock/skills)** (by Matt Pocock) is brilliant at *starting*. It turns a loose idea into a **shared map of decision tickets on your issue tracker**, named through a proper grilling conversation, with a visible frontier and a "fog of war" for what isn't sharp enough to plan yet. You resolve one decision per session and the map grows outward. What it deliberately doesn't do is *build*: it plans, then hands off.

- **GSD** (the [open-gsd](https://github.com/open-gsd/gsd-core) workflow system) is brilliant at *doing*. Its `discuss → plan → execute → verify` cycle, atomic commits, and zero-friction capture make the actual construction reliable and reviewable. But its state lives in a local `.planning/` tree, separate from where the team can see it.

Working across both, one pattern kept recurring: **use a Wayfinder-style map and onboarding to decide the shape of the work, then a GSD-style engine to build each piece, without ever leaving the issue tracker.** `trailhead` is that pattern made into a single skill, its own self-contained take on both ideas rather than a wrapper around either.

> **trailhead is self-contained.** Wayfinder and GSD are *inspiration*, not dependencies. Every technique those systems package as a separate skill (grilling, TDD, systematic debugging, codebase mapping, code review) is **built in here as an inline protocol**. trailhead's core invokes no other skill; its subagents (research, codebase-map, review) use the host's native subagents (Claude Code's built-in `Agent` tool, or Codex's `multi_agent` toolkit). The only thing to install is trailhead itself. There is one opt-in exception: when enabled, `claude.ai/design` mockup mode pushes to a design-system project via DesignSync (the `claude_design` MCP plus the `/design-sync` skill). If that isn't available, it silently falls back to local-disk mockups.

The design choices that fall out of it:

- **Everything lives on GitHub Issues.** The map is the parent issue; each ticket is a child issue; discussion, plan, and verification are *comments*. There is no `.planning/` directory: the repo holds code only, and the plan is always visible to anyone with the repo.
- **Execution happens inside the map.** Unlike pure Wayfinder ("plan, don't do"), build tickets graduate from the fog and are executed as children of the map. The destination is the **working artifact** (a deployed app), not a spec document, though a project can override that and stop at the spec.
- **Lean by default.** The heavy machinery (codebase mapping, systematic debugging) runs once where it earns its keep; the per-ticket cycle stays light.

- **Built for teams, because the plan is shared.** The tracker is the single source of truth, so the map is a **shared workspace**, not one person's local file. Many people (and their agents) work it at once, and the mechanics keep them from colliding:
  - **Claiming.** You take a ticket by assigning it to yourself; the assignee *is* the lock. A collision stops you and asks, rather than clobbering someone else's work. Whoever claims a ticket owns it end to end and closes it, no separate approver.
  - **A shared frontier, one ticket per session.** The **frontier** (open, unassigned, unblocked tickets) is the common queue of what's takeable now; each person picks a different one. Resolving a ticket ends the session, so work stays in reviewable, single-ticket chunks.
  - **Isolation for concurrent sessions on one machine.** Two agents editing one checkout corrupt each other, so the `isolation:` convention gives each in-flight ticket its own **`git worktree`** (or a full **`clone`** for path-bound apps a worktree can't build); disjoint `Scope:` lines let non-overlapping work run in parallel and serialise only where it truly overlaps.
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
On **Claude Code** it copies the skill (+ its `references/`), the `/trailhead:*` commands, the hooks (into `hooks/`, registered in `settings.json`) including a SessionStart **update check**, and the label-guard + statusline templates, idempotently.

On **Codex CLI** (`--codex`) it projects a native Codex skill invoked as **`$trailhead`** (`$trailhead work`, `$trailhead new "idea"`, …), one thin **`$trailhead-<verb>`** skill per verb for discoverability, the four guardrails as native Codex **hooks** (`~/.codex/hooks.json`, enabling `features.hooks`), and per-technique subagent model pins from **`models.codex.*`** into `~/.codex/agents/`. Codex **0.145.0+** is required (the installer gates on `codex --version`). The `claude.ai/design` mockup mode isn't available on Codex, so UI mockups fall back to local disk there.

Re-run the install to update, or run **`/trailhead:update`** (Claude) / **`$trailhead update`** (Codex) from inside the agent: it detects how trailhead was installed and installs the newer version where that is safe (a `git pull` for a dev-symlink, an `npx` re-run for npm, or `/plugin update` for the plugin). When a newer version exists, the statusline shows a `⬆ trailhead <version>` flag (Claude).

### After installing
Restart or reload your agent so the commands register, then run **`/trailhead`** to start (smart entry), or `/trailhead:new "<idea>"` to chart a map. **On Codex** the surface is `$trailhead` instead: run **`$trailhead`** for smart entry, `$trailhead new "<idea>"` to chart, or a per-verb `$trailhead-<verb>` skill. Note: once installed, the **commit guard hook runs on every `git commit`** (enforcing Conventional Commits and blocking `Co-Authored-By`); disable the plugin's hooks in settings if you don't want that. Either way trailhead is self-contained: no other skill or plugin is required, no preflight, no version drift.

---

## 🗺️ How it works

A **map** is one GitHub issue labelled `trailhead:map`. It's an index, not a store: a Destination, standing Notes, the `Decisions so far`, the `Not yet specified` fog, and what's `Out of scope`.

**What earns a map?** A map is the unit for an effort that is **too big to hold in one session** and carries **open decisions**, not just execution. In practice that's a **milestone** (a release, a version, "v2 of the dashboard"), or a **single feature big enough that you must decide before you can build it**: where the data lives, which library, what the screen actually does. Charting a map names its destination and fans that effort out into many tickets, wired by their dependencies. As the decisions resolve, the fog clears and the build tickets graduate, until the destination is reached.

What does **not** need its own map is a single, defined piece of work with no open questions, small enough to finish in one session. That is just **one ticket**, a direct `build` (or a `todo`): a *work* you take with `/trailhead:work` and resolve in a sitting, no charting required. **Rule of thumb: decisions to make, or too big for one sitting → a map; "just do X" → a single work.** A feature that starts as a lone work but turns out to need decisions gets promoted to its own map (or split); a map whose questions all evaporate collapses back to a handful of works. And a repo can hold **several maps at once** (parallel milestones or features), each with its own frontier, so you can park one and work another.

Each **ticket** is a child issue with a type label and a one-question body. The **frontier** is the set of open, unassigned tickets whose blockers are all closed: what's takeable right now. You claim a ticket by assigning it to yourself, resolve it with the engine for its type, then record the answer as a comment, close it, and gist it back onto the map.

As tickets resolve, the fog clears: questions that were too vague to phrase become sharp enough to ticket, one at a time, until nothing is left to decide or build and the destination is reached.

A map is scoped to **one** effort, so knowledge that belongs to the *repo* (not to any single map) lives in **repo-scoped anchor issues**, created once and shared by every map (each map's Notes just links them, so nothing is stranded when a map finishes):

- **`trailhead:codebase`**: the distilled codebase map (architecture, stack, conventions, risks, test/build), written once at adopt and refreshed only on major drift.
- **`trailhead:conventions`**: the project's **way of working**, readable by everyone: a small machine-read header the engine obeys (`git: main|pr`, `release: command|auto`, `isolation: none|worktree|clone`) over human prose. `/trailhead:adopt` and `:new` ask for it up front. `isolation: worktree` gives each executing ticket its own `git worktree` + branch (concurrent sessions on one clone never share a working tree); `isolation: clone` gives it a dedicated clone instead, for path-bound apps a worktree can't build.
- **`trailhead:dashboard`**: the pinned index of the whole surface, a link to every open map (with GitHub's native progress bars), the whiteboard, and live counts (inbox, whiteboard frontier). Refreshed when a map is charted or exhausted, when a whiteboard ticket is born or resolved (it has no native progress bar, so the dashboard is the only place it shows), and on demand via `/trailhead:dashboard`.

These three fill GitHub's **3 pinned-issue slots**, so a repo's trailhead anchors stay one click away; **maps themselves are never pinned** (they're indexed by the dashboard instead, since the "active" map is per-checkout local state, not a repo-global fact). Project *config* (models, TDD, design…) is separate again, a plain `.trailhead/config.json` file at the repo root, never in an issue.

---

## 🔄 Workflow

**The lifecycle.** Every project walks the same loop:

1. **Start**: `/trailhead:new "<idea>"` (greenfield) or `/trailhead:adopt` (existing code: map the codebase once, then go lean). This *charts the map*: name the destination, then map the frontier breadth-first into the first tickets and the fog.
2. **Work the frontier, one ticket per session**: `/trailhead:work` takes the next takeable ticket (or one you name) and runs the engine for its type: `research` gathers a fact · `decision` diverges options then grills to choose · `prototype` makes a rough artifact to react to · `build` runs discuss → plan → execute → verify · `bug` runs repro → diagnose → fix → verify · `task` is manual plumbing that unblocks a decision.
3. **Close & unblock**: resolve the ticket (comment + close), gist it into `Decisions so far`, and drop `trailhead:blocked` from any dependent whose last blocker just closed, graduating it onto the frontier.
4. **Repeat** until the frontier is empty and the fog has cleared: the destination (a working artifact) is reached.

Along the way: **capture** ideas mid-work without derailing, **split** a ticket that grew too big, **pause/resume** across sessions, and let several people work unblocked tickets in parallel.

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
- **④ prototype** → a rough login screen (on the configured claude.ai/design project), approved before UI code.
- With ②③④ closed, **⑤ build** graduates → discuss → plan → execute (atomic commits, TDD at the auth seams) → verify (tests + code review + acceptance: the agent drives the browser through the real login flow).
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
| `/trailhead:quick [ticket \| "text"]` | work one ticket whole, off the map: opens a whiteboard ticket from `"text"` (or takes `<n>`), runs the full engine, grills only if needed, never splits |
| `/trailhead:whiteboard` | show the whiteboard: the loose (map-less) tickets and their frontier |
| `/trailhead:inbox [issue]` | triage issues opened by others and integrate the good ones into the map |
| `/trailhead:resume [ticket]` | resume a paused ticket from its `PAUSED` checkpoint |
| `/trailhead:pause [note]` | checkpoint the ticket in play so anyone can resume it |
| `/trailhead:ticket <type> <title>` | open a ticket on the fly (diverges briefly first: a micro-charting act) |
| `/trailhead:split [ticket]` | split an oversized ticket into children, supersede the original |
| `/trailhead:grill [topic]` | run a standalone grilling session on a decision/topic |
| `/trailhead:map` | show the low-res map (destination, decisions, frontier, fog) |
| `/trailhead:dashboard` | show the repo dashboard: the pinned index of every open map, the whiteboard, and live counts |

### Capture: zero friction, one confirmation line, resolves nothing

| Command | Lands as | Meaning |
|---|---|---|
| `/trailhead:todo <text>` | a frontier ticket | *I'm doing it*: defined work, now |
| `/trailhead:seed <text>` | a blocked ticket (trigger noted) | *I'll do it when X happens* |
| `/trailhead:idea <text>` | the fog (`Not yet specified`) | *maybe I'll do it*: graduates to a ticket if it sharpens |
| `/trailhead:note <text>` | verbatim text | *remember this*: not necessarily work |
| `/trailhead:bug [--of <ticket>] <text>` | a `bug` ticket | a defect; `--of` records it as a `Regression of:` a closed ticket |

The four fog/ticket captures form a spectrum of commitment and timing: **note < idea < seed < todo**.

When a map is open, a capture that produces a ticket (`todo`/`bug`/`seed`/a sharp `idea`) asks whether to file it on the **active map** or the **whiteboard**, the home for loose, map-less work that doesn't belong to any map (or isn't worth charting one). With no map open it lands on the whiteboard. Work a whiteboard ticket with **`/trailhead:quick`** (which also opens one from `"text"` and works it in the same sitting), and see them all with `/trailhead:whiteboard`.

### 🧯 Don't get trapped in a map: the whiteboard

Deep in a map, something unrelated surfaces: a bug in another area, a chore, a quick idea you want to act on now. Forcing it onto the map's frontier pollutes the map; charting a whole new map for it is overkill. That is what the **whiteboard** is for, loose map-less work, and two moves keep you from getting stuck:

- **Capture it aside.** A `todo`/`bug`/`seed`/sharp `idea` fired while a map is open asks *map or whiteboard?*. Send it to the whiteboard and it stays off the map: tracked, but out of the way, so the map's frontier keeps meaning "the way to this destination".
- **Do it on the fly.** `/trailhead:quick "<text>"` opens a whiteboard ticket and works it end to end in the same sitting, the full discuss → plan → execute → verify engine (atomic commits, code review, the lot), except it **grills only if needed and never splits**, and skips every map book-keeping step. `/trailhead:quick <n>` does the same for a ticket that already exists.

See the whole whiteboard with `/trailhead:whiteboard`. Nothing about the map changes: you just stepped off it, did the thing, and step back on when you're ready.

The three that trip people up are **idea, seed, todo**, so here they are spelled out:

- **`idea`** = *maybe, and not yet clear.* It lands in the **fog** (`Not yet specified`), **not** as a ticket, because you can't even phrase the question sharply yet, so there is nothing to work. It **graduates** into a ticket later, when the frontier reaches it or it simply gets clearer.
- **`seed`** = *yes, but not yet.* It **is** a ticket, but **parked** (`trailhead:blocked`) on a **trigger** you name ("when the public API ships", "when we pass 1k users"). The question is already sharp; what's missing is a **condition**, not clarity. When the trigger fires, it graduates onto the frontier.
- **`todo`** = *yes, now.* Defined work you will just do: it's born a **`build` ticket on the frontier**, takeable immediately.

The two cuts that matter: **idea vs seed** is waiting on *clarity* vs waiting on a *condition* (both land "later", for different reasons); **seed vs todo** is committed *later* vs committed *now*. Below all three sits **`note`** (raw text to remember, maybe never work), and off to the side is **`bug`** (a defect, not a commitment tier). The test for idea vs ticket is always: **can you phrase the question precisely now?** Yes → a ticket (`todo` if takeable, `seed` if gated); no → the fog (`idea`).

---

## 🎫 Ticket types and their engines

Each ticket carries a type label; each type has its own way of being resolved.

Each type has its own inline engine: no external skill is invoked.

| Type | Produces | Mode | Engine |
|---|---|---|---|
| 🧭 `decision` | a choice | HITL | diverge the options if unclear, then grill to converge on one |
| 🔬 `research` | a fact | AFK | a subagent on a throwaway branch (the only type run in parallel) |
| 🎨 `prototype` | an approved direction | HITL | a rough throwaway artifact to react to; UI screens go through this (disk, or a configured claude.ai/design project) before UI code |
| 🔨 `build` | working code | HITL/AFK | `discuss → plan → execute → verify`: atomic commits, TDD at seams, **a mockup first for user-facing UI** (Prototype technique, gated by `design.approval`), code review + acceptance testing (browser-drive or conversational step-by-step UAT) |
| 🐛 `bug` | corrected code | HITL/AFK | `repro → diagnose → fix → verify`; a defect in closed work is a *new* ticket (`Regression of:`), not a reopen |
| 🔧 `task` | an external state change | HITL/AFK | manual work that unblocks a decision (provision access, move data, sign up) |

Two rules of thumb: build tickets **never auto-grill**: on blocking ambiguity the skill stops and asks; and brainstorming (divergence) lives in charting, in `ticket`'s micro-charting, and in a `decision`'s option phase, never in the grilling itself, which only converges.

---

## 🏷️ Labels

Everything the map needs is expressed as GitHub labels, so state is queryable in the tracker UI:

- **Structural:** `trailhead:map`, `trailhead:ticket`
- **Repo-scoped anchors (one each per repo, pinned):** `trailhead:codebase` 🧱 (the distilled codebase map), `trailhead:conventions` 📜 (the way of working), `trailhead:dashboard` 📊 (the pinned index of maps + whiteboard + counts) — each title carries its icon (like the map's 🗺) so the pinned anchors stand apart at a glance
- **Type (one per ticket):** 🧭 `trailhead:decision` · 🔬 `research` · 🎨 `prototype` · 🔨 `build` · 🐛 `bug` · 🔧 `task`
- **State:** `trailhead:blocked` (has an open blocker) · `seed` (parked on a trigger) · `out-of-scope` (closed, beyond the destination) · `superseded` (closed, split into children)
- **Container:** `trailhead:whiteboard` (a loose, map-less ticket, off every map's frontier, on the whiteboard's own)

The **frontier** is then a single query (open, unassigned, not `trailhead:blocked`), no body-parsing needed.

## 👥 Working as a team

Many people (and their agent sessions) share one map and work it concurrently:

- **Claim = assign to yourself.** The claimer owns the ticket end to end and closes it: there is no approver and no one to wait on. On a claim collision the session stops and asks you, rather than resolving it silently.
- **Split** an oversized ticket into children and supersede the original (`/trailhead:split`).
- **Pause/resume** via a `PAUSED` checkpoint comment, so any session can pick a ticket back up.
- **Isolate concurrent sessions with worktrees.** Claiming keeps two sessions off the *same* ticket, but two sessions on *different* tickets in the *same* clone still share one working tree. Set `isolation: worktree` in the conventions header and each executing ticket runs in its own `git worktree` on a `trailhead/t<n>` branch, integrated back to the trunk at Resolve. It implies a branch per ticket even under `git: main` (git won't check the trunk out twice), and it is the right posture for a **monorepo** (a worktree shares the object store, far cheaper than a second clone). One caveat: a worktree isolates *source* but is a fresh path with no installed deps, so a **path-bound package** (React Native/Expo, native toolchains, anything tied to a local `node_modules`) won't build from it. For those there's **`isolation: clone`**: a dedicated per-ticket clone that installs its own deps and builds/UATs like the real app (heavier than a worktree, and the right tool for an Expo/RN submodule). Or keep `isolation: none` and serialize. Otherwise run concurrent sessions in separate clones.
- **A session-ticket marker for your statusline.** When it starts working a ticket, trailhead drops a one-line, gitignored `.trailhead/session-ticket` (`#<n> <title>`) at the working root and clears it at handoff. It's purely a cheap, offline hint so a statusline (or any tool) can show *which ticket this session is on* without hitting the tracker; trailhead itself still treats the Issues as the source of truth.
- **It nudges you when isolation was never chosen.** If a repo was charted or adopted before you set an `isolation:` mode (so it silently defaults to `none`), the first time you go to work a ticket with a real collision risk (another ticket in progress, or path-bound tooling in its `Scope:`) trailhead surfaces a one-line suggestion of the fitting mode (`worktree` or `clone`) instead of quietly editing the shared checkout. Whatever you decide, including keeping `none`, it writes the `isolation:` key into the conventions so the choice is recorded and it never asks again. A header that already set `isolation:` is left alone.
- **Scope tickets by path on a monorepo.** A ticket can carry a `Scope:` line naming the package/dir(s) it touches: disjoint scopes parallelize safely, and it scopes build/test and the worktree's commits to the affected package. `/trailhead:adopt` detects a monorepo and proposes both `isolation: worktree` and the `Scope:` convention. Under `isolation: none`, `Scope:` also **serializes** a shared area: at claim time a session holds off if another in-progress ticket's scope overlaps, so two tickets scoped to the same submodule/package can't run at once (how you keep two sessions off one path-bound app).
- **Git submodules are handled as separate repos.** Work that lands inside a submodule is committed *inside the submodule* plus a gitlink bump in the parent, and (under `worktree`) isolated at the submodule, not the superproject. A ticket spanning two submodules stays atomic via a single parent commit that bumps both gitlinks together; its `Scope:` names both. `/trailhead:adopt` detects `.gitmodules` and writes the rule into the conventions.
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
- **Global**: `~/.claude/trailhead/config.json`: your standing defaults across every project.
- **Defaults**: the built-in values.

`/trailhead:config` runs a **guided, menu-driven setup**: pick the scope, then walk each setting (🌐 ticket language · 🧠 models · 🎨 design + approval · 🧪 TDD · 🖥️ acceptance testing · 🧑‍⚖️ plan review · 📊 statusline) as an icon-labelled menu; no hand-editing JSON. Every step is asked (none skipped), and **plan and execute models are always two separate, version-pinned choices**. `config get` prints the effective merged config; `config set <key> <value>` writes one key.

The **📊 statusline** step offers to install trailhead's Claude Code status bar: one line with **model · project · branch · plan usage (`5h %` · reset · `7d %`) · a context-window bar**, plus a **second line with the active ticket** (`▸ #N Title`) whenever you're working one, and a `⬆ trailhead <version>` flag when a newer trailhead is available (run `/trailhead:update`). The project is always the main repo's name even from an isolated checkout, and the branch carries a `(WT)` tag in a worktree or `(C)` in a per-ticket clone (nothing on the original checkout). It's a global Claude Code setting; if you already run a statusline (e.g. `ccstatusline`) the setup asks before replacing it, and the script also exposes `--ticket-only` / `--context-only` / `--usage-only` segments to slot into an existing tool.

**First-use offer (once per project).** You don't have to seek this out: the first time you set a project up (at the end of `/trailhead:new`/`:adopt`, or on a bare `/trailhead` when a map exists but no config does) trailhead offers to run the guided setup, or to continue on defaults. It asks **only once**: configuring writes `.trailhead/config.json`, and "continue on defaults" writes an empty `{}`. Once that file exists it's never offered again, and it never interrupts mid-ticket.

| Key | Values (default **bold**) | Effect |
|---|---|---|
| `ticket.language` | an ISO 639-1 code (**`en`**) | the language trailhead **writes** its GitHub prose & commit descriptions in, decoupled from the language it converses in |
| `models.{plan,execute,research,review,debug}` | a full **versioned** model id (**inherit session**) | which model runs each activity; `plan` and `execute` are always set separately |
| `design` | **`disk`** \| `claude.ai/design` | where UI mockups go: local throwaway HTML, or a design-system project on claude.ai/design via DesignSync |
| `design.approval` | **`explicit`** \| `auto` | wait for mockup approval before UI code, or proceed without blocking |
| `tdd` | **`seams`** \| `on` \| `off` | how the `build` engine tests |
| `acceptance.browser` | **`auto`** \| `on` \| `off` | drive the browser in Verify, or walk you through a conversational UAT (step by step in chat, not a checklist to self-serve) |
| `testing.webapp` / `testing.url` | bool / URL | is it browser-drivable, and where |
| `plan_review` | **`off`** \| `on` \| CLI list | send `build` PLANs to external AI CLIs (Gemini, Codex, …) for a second opinion and converge on their concerns |
| `plan_review.rounds` | integer (**`2`**) | max converge-and-re-review rounds |

**Models.** Each key runs its activity as a **subagent** on the model you name, so the whole per-activity split applies within a single work session, whatever model that session runs on:

- `plan` and `execute` are the build/bug engine's steps. Execute is a subagent too, and it commits to `main`.
- `research`, `review`, `debug`, and the codebase-map fan-out each run on their own key.

Choose `plan` and `execute` separately, each by **full versioned id** (never a bare `opus` or `sonnet`). A key that is unset, or equal to the session model, simply runs inline.

The **main session stays the orchestrator**. It holds the interactive moments (a build's Discuss, and Verify's acceptance/UAT) and it does charting, grilling, and ticket-writing on its own model. No key governs ticket quality, so run charting sessions on your strong model.

Example config file (the same shape works for the project `.trailhead/config.json` and the global `~/.claude/trailhead/config.json`):

```json
{ "ticket": { "language": "en" }, "models": { "plan": "claude-opus-4-8", "execute": "claude-sonnet-5" }, "tdd": "seams", "acceptance": { "browser": "auto" } }
```

**Design mockups.** `design: disk` (the default) drops a throwaway static HTML mockup next to the code and links it from the ticket. `design: claude.ai/design` instead pushes the mockup to a **design-system project** on claude.ai/design via **DesignSync** (the `/design-sync` skill plus the `claude_design` MCP), where you refine it visually.

On the first UI screen, trailhead asks which design system to use. You can:

- **pick from your 10 most-recent**,
- **paste a `claude.ai/design/p/<id>` URL**, or
- **create a new one** (it asks you for the name).

It caches the chosen id in `design.project`. Each screen is pushed there, and its URL is linked from the ticket. Once you approve, trailhead **re-fetches** the current design (in case you edited it live) before writing any UI code.

DesignSync drives only design-system projects, not regular ones; for a regular project you place the mockup by hand. `design.approval` decides whether the build waits for your explicit go-ahead (`explicit`), or proceeds right after surfacing the mockup (`auto`).

---

## 🪝 Hooks

Beyond the skill's instructions, trailhead ships three of its own hooks (in `hooks/`, self-contained via `${CLAUDE_PLUGIN_ROOT}`) that *enforce* the parts of the discipline the model shouldn't be trusted to remember:

- **Commit guard** (`PreToolUse` on `git commit`): hard-blocks a commit whose subject isn't [Conventional Commits](https://www.conventionalcommits.org), and hard-blocks any `Co-Authored-By` trailer. This mirrors GSD's commit validation.
- **Secret guard** (`PreToolUse` on `gh` issue/PR writes): trailhead posts a lot to the tracker (ticket bodies, engine comments, codebase/conventions issues, resolutions). This scans what a `gh issue`/`gh pr`/`gh api` write is about to post (the inline `--body`, a heredoc, or a `--body-file`) and **hard-blocks** it if it matches a credential pattern (private keys, GitHub/AWS/OpenAI/Slack/Google/Stripe tokens, JWTs, or a hardcoded `password`/`secret`/`token=…`). The block is a **clean-and-retry cue, not a dead end**: trailhead redacts the flagged value in place (`<REDACTED>` or an env-var reference) and re-posts automatically, so the cleaned content still lands: the secret just never reaches the tracker. It stays a fail-safe *block* rather than a silent auto-rewrite on purpose: a block never leaks, whereas a redaction that quietly failed to apply would. It never scans reads, only outbound writes.
- **Issue injection scanner** (`PostToolUse` on `gh` reads): trailhead reads issue/PR/comment text written by anyone with repo access, i.e. untrusted input. When that text contains prompt-injection phrases, the hook injects an advisory reminding the agent to treat it as data, never as commands. Advisory only: it never blocks.

All three are crash-safe (any error → allow) and active whenever the plugin is installed. The commit and secret guards therefore apply in **every** repo, not only trailhead projects: intentional, since conventional commits, no `Co-Authored-By`, and no leaked secrets are trailhead's standing rules. To opt out, disable the plugin's hooks in your Claude Code settings.

---

## 🙏 Acknowledgements

`trailhead` stands on the shoulders of two bodies of work. It is an original, self-contained methodology **inspired by** them. It does not copy or redistribute their code, and it invokes none of their skills; it reimplements the ideas as its own inline protocols:

- **[Matt Pocock](https://www.aihero.dev)**: for **Wayfinder**, whose map / frontier / fog-of-war model is the backbone of trailhead's planning half, and whose `grilling`, `domain-modeling`, `prototype`, `research`, and `tdd` skills shaped trailhead's inline techniques. See [`mattpocock/skills`](https://github.com/mattpocock/skills).
- **The [open-gsd](https://github.com/open-gsd/gsd-core) team**: for **GSD**, whose `discuss → plan → execute → verify` cycle, capture model, codebase mapping, and systematic debugging are the engine of trailhead's building half.

Thank you. If you like the ideas here, go star and use the originals: they go far deeper than trailhead's compact protocols.

---

## 📄 License

MIT © Marco Migozzi ([@ToRvaLDz](https://github.com/ToRvaLDz))
