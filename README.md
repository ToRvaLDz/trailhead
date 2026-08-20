# trailhead

**Start and drive large projects as a map of tickets on GitHub Issues, resolving one at a time until the way to the destination is clear.**

`trailhead` is an orchestrator skill for [Claude Code](https://docs.claude.com/en/docs/claude-code). It gives a big, foggy idea a place to begin (a *trailhead*) and a disciplined way to walk it to a working result, with the whole plan living on your issue tracker instead of in scattered local files.

---

## 💡 Why trailhead exists

Two approaches to agent-driven project work each nail one half of the problem:

- **[Wayfinder](https://github.com/mattpocock/skills)** (by Matt Pocock) is brilliant at *starting*. It turns a loose idea into a **shared map of decision tickets on your issue tracker**, named through a proper grilling conversation, with a visible frontier and a "fog of war" for what isn't sharp enough to plan yet. You resolve one decision per session and the map grows outward. What it deliberately doesn't do is *build*: it plans, then hands off.

- **GSD** (the [open-gsd](https://github.com/open-gsd/gsd-core) workflow system) is brilliant at *doing*. Its `discuss → plan → execute → verify` cycle, atomic commits, and zero-friction capture make the actual construction reliable and reviewable. But its state lives in a local `.planning/` tree, separate from where the team can see it.

Working across both, one pattern kept recurring: **use Wayfinder's map and onboarding to decide the shape of the work, then use GSD's engine to build each piece, without ever leaving the issue tracker.** `trailhead` is that pattern made into a single skill.

> **trailhead is self-contained.** Wayfinder and GSD are *inspiration*, not dependencies. Every technique those systems package as a separate skill (grilling, TDD, systematic debugging, codebase mapping, code review) is **built in here as an inline protocol**. trailhead's core invokes no other skill; its subagents (research, codebase-map, review) use Claude Code's built-in `Agent` tool. The only thing to install is trailhead itself. There is one opt-in exception: when enabled, `claude.ai/design` mockup mode pushes to a design-system project via DesignSync (the `claude_design` MCP plus the `/design-sync` skill). If that isn't available, it silently falls back to local-disk mockups.

The design choices that fall out of it:

- **Everything lives on GitHub Issues.** The map is the parent issue; each ticket is a child issue; discussion, plan, and verification are *comments*. There is no `.planning/` directory: the repo holds code only, and the plan is always visible to anyone with the repo.
- **Execution happens inside the map.** Unlike pure Wayfinder ("plan, don't do"), build tickets graduate from the fog and are executed as children of the map. The destination is the **working artifact** (a deployed app), not a spec document, though a project can override that and stop at the spec.
- **Lean by default.** The heavy machinery (codebase mapping, systematic debugging) runs once where it earns its keep; the per-ticket cycle stays light.

---

## 📦 Install

> **Claude Code only, for now.** trailhead installs as a Claude Code skill + `/trailhead:*` commands + hooks. It's built to grow to other AI CLIs later (the installer already uses a per-agent adapter), but today Claude Code is the only supported host.

**Prerequisites:** an authenticated [`gh` CLI](https://cli.github.com) (the tracker is GitHub Issues) and a GitHub repo to work in. The npm path also needs Node 18+.

### As a Claude Code plugin (native, managed by `/plugin`)
```
/plugin marketplace add ToRvaLDz/trailhead
/plugin install trailhead@trailhead
```
Update with `/plugin update trailhead`; remove with `/plugin uninstall trailhead`.

### Or via npm (installs into your agent's config dir)
```
npx @marcomigozzi/trailhead              # install into ~/.claude (or $CLAUDE_CONFIG_DIR)
npx @marcomigozzi/trailhead --symlink    # dev install (symlink to the checkout, edits go live)
npx @marcomigozzi/trailhead --uninstall  # remove everything it added
npx @marcomigozzi/trailhead --dir=<path> # target a specific config dir
```
It copies the skill (+ its `references/`), the `/trailhead:*` commands, the three hooks (into `hooks/`, registered in `settings.json`), and the label-guard template, idempotently. Re-run `npx @marcomigozzi/trailhead` to update.

### After installing
Restart or reload your agent so the commands register, then run **`/trailhead`** to start (smart entry), or `/trailhead:new "<idea>"` to chart a map. Note: once installed, the **commit guard hook runs on every `git commit`** (enforcing Conventional Commits and blocking `Co-Authored-By`); disable the plugin's hooks in settings if you don't want that. Either way trailhead is self-contained: no other skill or plugin is required, no preflight, no version drift.

---

## 🗺️ How it works

A **map** is one GitHub issue labelled `trailhead:map`. It's an index, not a store: a Destination, standing Notes, the `Decisions so far`, the `Not yet specified` fog, and what's `Out of scope`.

Each **ticket** is a child issue with a type label and a one-question body. The **frontier** is the set of open, unassigned tickets whose blockers are all closed: what's takeable right now. You claim a ticket by assigning it to yourself, resolve it with the engine for its type, then record the answer as a comment, close it, and gist it back onto the map.

As tickets resolve, the fog clears: questions that were too vague to phrase become sharp enough to ticket, one at a time, until nothing is left to decide or build and the destination is reached.

A map is scoped to **one** effort, so knowledge that belongs to the *repo* (not to any single map) lives in two **repo-scoped anchor issues**, created once and shared by every map (each map's Notes just links them, so nothing is stranded when a map finishes):

- **`trailhead:codebase`**: the distilled codebase map (architecture, stack, conventions, risks, test/build), written once at adopt and refreshed only on major drift.
- **`trailhead:conventions`**: the project's **way of working**, readable by everyone: a small machine-read header the engine obeys (`git: main|pr`, `release: command|auto`, `isolation: none|worktree`) over human prose. `/trailhead:adopt` and `:new` ask for it up front. `isolation: worktree` gives each executing ticket its own `git worktree` + branch, so concurrent sessions on one clone (a monorepo especially) never share a working tree.

Together with the map, these three fill GitHub's **3 pinned-issue slots**, so a repo's trailhead anchors stay one click away. Project *config* (models, TDD, design…) is separate again, a plain `.trailhead/config.json` file at the repo root, never in an issue.

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
| `/trailhead:inbox [issue]` | triage issues opened by others and integrate the good ones into the map |
| `/trailhead:resume [ticket]` | resume a paused ticket from its `PAUSED` checkpoint |
| `/trailhead:pause [note]` | checkpoint the ticket in play so anyone can resume it |
| `/trailhead:ticket <type> <title>` | open a ticket on the fly (diverges briefly first: a micro-charting act) |
| `/trailhead:split [ticket]` | split an oversized ticket into children, supersede the original |
| `/trailhead:grill [topic]` | run a standalone grilling session on a decision/topic |
| `/trailhead:map` | show the low-res map (destination, decisions, frontier, fog) |

### Capture: zero friction, one confirmation line, resolves nothing

| Command | Lands as | Meaning |
|---|---|---|
| `/trailhead:todo <text>` | a frontier ticket | *I'm doing it*: defined work, now |
| `/trailhead:seed <text>` | a blocked ticket (trigger noted) | *I'll do it when X happens* |
| `/trailhead:idea <text>` | the fog (`Not yet specified`) | *maybe I'll do it*: graduates to a ticket if it sharpens |
| `/trailhead:note <text>` | verbatim text | *remember this*: not necessarily work |
| `/trailhead:bug [--of <ticket>] <text>` | a `bug` ticket | a defect; `--of` records it as a `Regression of:` a closed ticket |

The four fog/ticket captures form a spectrum of commitment and timing: **note < idea < seed < todo**. Discriminator: not even work → `note`; maybe, once it's clear → `idea`; yes, when X happens → `seed`; yes, now → `todo`.

---

## 🎫 Ticket types and their engines

Each ticket carries a type label; each type has its own way of being resolved.

Each type has its own inline engine: no external skill is invoked.

| Type | Produces | Mode | Engine |
|---|---|---|---|
| 🧭 `decision` | a choice | HITL | diverge the options if unclear, then grill to converge on one |
| 🔬 `research` | a fact | AFK | a subagent on a throwaway branch (the only type run in parallel) |
| 🎨 `prototype` | an approved direction | HITL | a rough throwaway artifact to react to; UI screens go through this (disk, or a configured claude.ai/design project) before UI code |
| 🔨 `build` | working code | HITL/AFK | `discuss → plan → execute → verify`: atomic commits, TDD at seams, code review + acceptance testing (browser-drive or conversational step-by-step UAT) |
| 🐛 `bug` | corrected code | HITL/AFK | `repro → diagnose → fix → verify`; a defect in closed work is a *new* ticket (`Regression of:`), not a reopen |
| 🔧 `task` | an external state change | HITL/AFK | manual work that unblocks a decision (provision access, move data, sign up) |

Two rules of thumb: build tickets **never auto-grill**: on blocking ambiguity the skill stops and asks; and brainstorming (divergence) lives in charting, in `ticket`'s micro-charting, and in a `decision`'s option phase, never in the grilling itself, which only converges.

---

## 🏷️ Labels

Everything the map needs is expressed as GitHub labels, so state is queryable in the tracker UI:

- **Structural:** `trailhead:map`, `trailhead:ticket`
- **Repo-scoped anchors (one each per repo):** `trailhead:codebase` (the distilled codebase map), `trailhead:conventions` (the way of working)
- **Type (one per ticket):** 🧭 `trailhead:decision` · 🔬 `research` · 🎨 `prototype` · 🔨 `build` · 🐛 `bug` · 🔧 `task`
- **State:** `trailhead:blocked` (has an open blocker) · `seed` (parked on a trigger) · `out-of-scope` (closed, beyond the destination) · `superseded` (closed, split into children)

The **frontier** is then a single query (open, unassigned, not `trailhead:blocked`), no body-parsing needed.

## 👥 Working as a team

Many people (and their agent sessions) share one map and work it concurrently:

- **Claim = assign to yourself.** The claimer owns the ticket end to end and closes it: there is no approver and no one to wait on. On a claim collision the session stops and asks you, rather than resolving it silently.
- **Split** an oversized ticket into children and supersede the original (`/trailhead:split`).
- **Pause/resume** via a `PAUSED` checkpoint comment, so any session can pick a ticket back up.
- **Isolate concurrent sessions with worktrees.** Claiming keeps two sessions off the *same* ticket, but two sessions on *different* tickets in the *same* clone still share one working tree. Set `isolation: worktree` in the conventions header and each executing ticket runs in its own `git worktree` on a `trailhead/t<n>` branch, integrated back to the trunk at Resolve. It implies a branch per ticket even under `git: main` (git won't check the trunk out twice), and it is the right posture for a **monorepo** (a worktree shares the object store, far cheaper than a second clone). One caveat: a worktree isolates *source* but is a fresh path with no installed deps, so a **path-bound package** (React Native/Expo, native toolchains, anything tied to a local `node_modules`) won't build from it: for those, keep `isolation: none` and serialize the work or use a dedicated clone. Otherwise run concurrent sessions in separate clones.
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

`/trailhead:config` runs a **guided, menu-driven setup**: pick the scope, then walk each setting (🌐 ticket language · 🧠 models · 🎨 design + approval · 🧪 TDD · 🖥️ acceptance testing · 🧑‍⚖️ plan review) as an icon-labelled menu; no hand-editing JSON. Every step is asked (none skipped), and **plan and execute models are always two separate, version-pinned choices**. `config get` prints the effective merged config; `config set <key> <value>` writes one key.

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
