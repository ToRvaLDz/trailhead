---
name: trailhead
description: "Start and drive a large project (more than one agent session can hold) as a map of decision tickets on GitHub Issues, resolving one at a time until the way to the destination is clear. Self-contained: map-based onboarding and a discuss→plan→execute→verify engine with atomic commits, with everything (map, discussion, plan, verification) living on the Issues. No dependencies beyond an authenticated gh CLI. Invoke only when the user explicitly runs `/trailhead` (or a `/trailhead:<verb>` command) or asks to chart, adopt, or work a trailhead map, and do not auto-invoke for generic planning, project, or task-tracking requests."
argument-hint: "[new|adopt|work|ticket|inbox|map|config|grill|split|pause|resume|bug|todo|idea|seed|note] [text | ticket]"
---

A loose idea has arrived, too big for one session: the way from here to the **destination** isn't visible yet. `trailhead` is where the trail begins. It charts the way as a **shared map on GitHub Issues**, then works its **tickets**, one at a time, until the road is clear and the destination reached.

The method fuses two lineages, both as **inspiration**; `trailhead`'s core invokes no other skill and depends on nothing but an authenticated `gh` CLI (the one opt-in exception: `claude.ai/design` mockup mode uses **DesignSync** (the `claude_design` MCP + `/design-sync` skill) to push to a design-system project, and falls back to disk if it's unavailable):
- **From Wayfinder: the map.** Question-driven onboarding, the destination named first, the frontier, the fog of war, reference *by name*, one ticket per session.
- **From GSD: the engine.** Zero-friction capture and the `discuss → plan → execute → verify` cycle with atomic commits that resolves each build ticket *inside* the map.

The techniques those lineages package as separate skills (grilling, TDD, systematic debugging, codebase mapping, code review) are **built in here as inline protocols** (see [Techniques](#techniques)). `trailhead` is self-contained.

**Everything lives on the Issues.** No `.planning/`: the map is the parent issue, each ticket is a child issue, and discussion / plan / verification are **comments** on the ticket. The repo holds code only.

## Requirements

Only an **authenticated `gh` CLI**: the tracker is GitHub Issues. Nothing else to install. The subagents `trailhead` spawns (research, codebase-map, review) use the built-in `Agent` tool; every technique is defined inline below.

## Commands

The **first word** of `$ARGUMENTS` is the verb; the rest is the text (or a ticket number). With no verb, `/trailhead` does **smart entry**: it detects the repo state and proposes (no map → offer *chart* or *adopt*; map present → *work* the next frontier ticket).

**First-time config offer (once per project).** When a project has a map but **no `.trailhead/config.json` yet**, smart entry first offers to run `/trailhead:config` (set models/design/TDD/…, or continue on defaults), then proceeds. Ask this **only once**: running config writes the file, and *continue on defaults* writes an empty `{}`, so once `.trailhead/config.json` exists it's never offered again (a `{}` file means "reviewed, using defaults"). The same offer is made at the end of chart/adopt (Mode 1/1-bis). It fires on the bare `/trailhead` and when setting a project up, never in the middle of working a ticket.

Every verb is also a **namespaced command** (`/trailhead:new`, `/trailhead:work`, `/trailhead:bug`, …) so typing `/trailhead` lists them all in the picker. They're thin wrappers that delegate here; `/trailhead <verb>` and `/trailhead:<verb>` are equivalent.

**Flow**
| Command | What it does |
|---|---|
| `/trailhead` | smart entry: detect and propose |
| `/trailhead:new [idea]` | chart a new map → Mode 1 |
| `/trailhead:adopt` | adopt an existing project → Mode 1-bis |
| `/trailhead:work [ticket]` | work the map: the next frontier ticket, or the one you name → Mode 2 |
| `/trailhead:inbox [issue]` | triage issues opened by others and integrate the worthwhile ones into the map |
| `/trailhead:resume [ticket]` | resume a paused ticket: read its latest `PAUSED` checkpoint and continue |
| `/trailhead:pause [note]` | checkpoint the ticket in play so it can be resumed later (by you or anyone) |
| `/trailhead:split [ticket]` | split an oversized ticket into children and supersede the original |
| `/trailhead:ticket <type> <title>` | open one child ticket of the map on the fly (`type` = decision\|research\|prototype\|build\|bug\|task) |
| `/trailhead:grill [topic]` | run a standalone grilling session on a decision/topic (or a named ticket) |
| `/trailhead:map` | show the low-res map (destination, decisions, frontier, fog) |
| `/trailhead:config [get\|set …]` | show the effective config (global + project), or set a key |

**Capture** (zero friction, one confirmation line, resolves nothing → Mode 3):
| Command | Destination |
|---|---|
| `/trailhead:bug [--of <ticket>] <text>` | a `trailhead:bug` ticket on the frontier; `--of` records it as a `Regression of: <ticket>` |
| `/trailhead:todo <text>` | a small ticket on the frontier: work you *will* do |
| `/trailhead:idea <text>` | a line in *Not yet specified* (the fog); a ticket only if already razor-sharp |
| `/trailhead:seed <text>` | a blocked ticket with its trigger noted in `## Blocked by` |
| `/trailhead:note <text>` | a verbatim note (fog; outside a project → `$HOME/.claude/notes/`) |

Missing text in a capture → ask for the line. Unrecognised verb → treat the whole string as `idea`.

**Idea vs todo:** `idea` is a maybe-later thought (fog by default, graduates when the frontier reaches it); `todo` is defined work you will do (born a ticket). The test stays Wayfinder's: can you *phrase* the question precisely now? Yes → ticket, no → fog.

## Principles

- **Execution inside the map (default).** Unlike pure Wayfinder ("plan, don't do"), here the map carries **construction** within it: after the decision tickets, build tickets graduate from the fog and are **executed** as children of the map. The destination is the **working** artifact (a deployed app), not a spec document; the spec is a waypoint. *Override:* a project that must stop at the spec declares it in the map's `## Notes` (that wins over this default).
- **Refer by name.** Every map and ticket is an issue, so it has a **title**. In everything the human reads, refer by name, never by a bare `#number`. A wall of `#42, #43, #44` is illegible; names read at a glance. The id and URL don't vanish (a name wraps its link) but they ride *inside* the name. **One exception: a command the user must run.** In `/trailhead:work <ticket>` the argument is machine input, not prose; give the **bare number** there (a long title, with its punctuation and jargon, is awkward and error-prone to type). Name the ticket in the surrounding sentence, put the number in the command.
- **Result-oriented output.** In the chat, report **what was done and the next step**: refer to tickets by name and give the concrete next command. Do **not** expose trailhead's internal machinery: Mode labels (`Mode 1`, …), protocol/step names (`DISCUSS`/`PLAN`/`VERIFY`, "the build engine", "Session handoff", "graduate the fog", "the frontier"), or wrapper/SKILL.md mechanics. **Nor narrate the conventions and config you are silently obeying**: the git mode (`main`/`pr`), the isolation/worktree decision, submodule commit mechanics (commit-inside + gitlink bump), claim/assignment plumbing, which model ran a step. These are housekeeping you just *do*; reciting them ("the conventions say `git: main`, no worktree isolation, submodule work commits inside + a gitlink bump, and the ticket is already assigned to you") is noise, not a status update. Just act, then report the outcome. Surface a convention only when it **changes what the user must do** (a UAT they run, a release awaiting their command, a genuine claim collision with *another* login) or when they explicitly ask. (A map may reinforce this in its `## Notes`, but it holds regardless.)
- **No em-dashes.** Write with ordinary punctuation: commas, colons, semicolons, parentheses, periods. Never use an em-dash (U+2014), and never a hyphen standing in for a comma. This holds for **everything trailhead produces**: ticket titles and bodies, engine comments, the map body, commit descriptions, chat output, and the skill's own source docs. En-dashes in numeric ranges (`1–2`) and the arrow `→` in trailhead's notation stay; only the em-dash is banned.
- **One ticket per session: hard rule.** Resolve **at most one** ticket per session; once one is resolved, do **not** start a second; end the session instead. The only exceptions: `research` tickets (AFK, run in parallel) and `capture` operations (they resolve nothing). On resolving a ticket, close the session with the **[Session handoff](#session-handoff)** ritual.
- **Git per the repo's conventions.** The default is commit straight to `main`, conventional commits, no feature branch/PR, but the repo's `trailhead:conventions` issue governs: honour its `git:` (`main` | `pr`), `release:` (`command` | `auto`), and `isolation:` (`none` | `worktree`) header. Never `Co-Authored-By`.

## Session handoff

Resolving a ticket **ends the session**: one ticket per session is a hard rule (see [Principles](#principles)). So every resolution closes the same way. After the resolution comment + `gh issue close` + the `Decisions so far` update, **always** sign off with, in order:

1. **A one-line confirmation** the ticket is resolved, by name (not a bare `#number`).
2. **The next step: a scannable block, `/clear` FIRST, always.** Never bury it in prose, and **never point at the next ticket without leading with `/clear`**. State the `/clear` **every time** (not only when context is heavy): it must come *before* the next command, so the next ticket starts on clean context. Render it as a short labelled list in the user's conversation language, along these lines:

   > **Prossimo passo:**
   > - `/clear`: per liberare il contesto
   > - poi `/trailhead:work <numero>` per lavorare **<nome del prossimo ticket>** (oppure `/trailhead:work` che prende **<numero>** in automatico)
   > - in alternativa `/trailhead:map` per la vista completa e scegliere tu

   Name the next frontier ticket so the user knows what they're taking; put its **number** in the command (never the title). **No handoff command ever takes a free-text argument.** The only commands a handoff block may contain are `/clear`, `/trailhead:work` (bare or `<number>`), and `/trailhead:map`. Never hand the user a `/trailhead:ticket <type> "<title>"` (or any title-bearing command) to type.

   **If the frontier is empty**, that usually means fog that this resolution made specifiable should have been **graduated into a ticket already** (Mode 2 step 5), so the frontier isn't actually empty. If it genuinely is (nothing ticketable yet, or the user must choose which fog item to take next), point the block to **`/trailhead:map`** and offer to open the next ticket *yourself* once they say which one, rather than pre-filling a `/trailhead:ticket` command for them. (The example is Italian; match whatever language you're conversing in.)

**This block is required whenever you point the user at the next ticket**, including in a **later follow-up**, after answering their questions, not only in the instant you resolve the ticket. Never write "next: `/trailhead:work …`" without the `/clear` line above it.

This ritual fires from every **Resolve** step (`build`, `bug`) and from **Mode 2**'s close (which resolves `decision` / `prototype` / `task` too). It does **not** fire after a `capture` (resolves nothing) or a parallel `research` batch (AFK, not session-ending).

## Substrate: GitHub Issues

The tracker is GitHub via the `gh` CLI (account already authenticated). **Never post a secret to an issue**: everything trailhead writes (ticket bodies, engine comments, the codebase/conventions issues, resolutions) is public tracker text, so redact credentials proactively with `<REDACTED>` or an env-var reference (the Debug **Redact** protocol applies to *all* engine writes, not just debugging). A shipped **secret-guard hook** hard-blocks any `gh` issue/PR write that still contains one. If it fires, treat the block as a **clean-and-retry cue, not a dead end**: redact the flagged value in place (`<REDACTED>` or an env-var reference like `$SUPABASE_KEY`), then re-post, silently, without surfacing the block to the user as a failure. (The hook only *blocks*; it can't rewrite the write, which is deliberate: a fail-safe block never leaks, whereas a silent auto-redact that didn't apply would. The redaction is yours to do.) If the block looks like a false positive, reword so it no longer matches a credential pattern. Conventions:

| Element | How |
|----------|------|
| Map | an issue with label `trailhead:map`. **Pin it** while it's live, along with the codebase and conventions issues: GitHub's **3 pinned-issue slots** are exactly map + codebase + conventions, so the repo's trailhead anchors stay one click away (`gh api graphql` `pinIssue` mutation on each issue's node id). **When a map is exhausted** (destination reached: no open tickets and no fog left), **unpin it** (`unpinIssue` mutation) to free its slot; the map issue stays open as the record, just unpinned. The **codebase and conventions stay pinned permanently** (repo-scoped); the next map charted on the repo takes the freed slot. |
| Codebase | a **single per-repo** issue with label `trailhead:codebase`: the distilled codebase map (architecture, stack, conventions, decisions embodied, risks, test/build). It's repo-scoped: **shared by every map of this repo, owned by none**, so it survives when a map is finished. Each map's Notes *links* it (never re-inlines it). Not a `trailhead:ticket`, so it's off the frontier. Written at adopt, refreshed only on major drift. |
| Conventions | a **single per-repo** issue with label `trailhead:conventions`: the project's **way of working**, readable by everyone. Repo-scoped and linked from every map's Notes, like Codebase. It opens with a small machine-read header the engine obeys, then human prose. Header keys (defaults **bold**): `git:` **`main`** \| `pr` (commit straight to `main`, or feature branch + PR) · `release:` **`command`** \| `auto` (never release without an explicit command, or release automatically per the project's flow) · `isolation:` **`none`** \| `worktree` \| `clone` (work in the current checkout; or give each executing ticket its own `git worktree` + `trailhead/t<n>` branch; or a dedicated per-ticket **clone** at `../<repo>-t<n>` for **path-bound apps a worktree can't build**, e.g. React Native/Expo with a local `node_modules`; see [Working as a team](#working-as-a-team)). **`worktree`/`clone` imply a branch per ticket even under `git: main`** (git won't check the trunk out twice); the branch integrates to the trunk per `git:` at Resolve. Under **`none`** two in-progress tickets with overlapping `Scope:` **serialise** (the second holds at claim). Below the header: the standing "how we work here" notes. **Filled at chart/adopt by a brief conventions brainstorming** (see the Invocation modes), not a `trailhead:ticket`, off the frontier. |
| Ticket | a child issue with label `trailhead:ticket` + exactly one **type** label: `trailhead:decision` / `trailhead:research` / `trailhead:prototype` / `trailhead:build` / `trailhead:bug` / `trailhead:task` |
| Child→map link | a `Parent: <map name>(link)` line in the ticket body |
| Path scope (monorepo) | an optional `Scope: <path>[, <path>…]` line in the ticket body naming the package/dir(s), or **submodule path(s)**, the ticket works in. It sharpens the [undeclared-coupling check](#working-as-a-team) (disjoint scopes parallelize safely), scopes build/test to the affected package, and scopes an `isolation: worktree` worktree's commits. **List every one it touches** (a ticket spanning two submodules names both). **Omit it in a single-package repo** (the whole tree is the scope); add it only where a repo has independent packages/subtrees or submodules. |
| Blocking | **Find every blocker first: from the ticket's own Question.** Each still-open ticket whose output this ticket *consumes as an input* is a blocker: a decision that needs another's answer, a build that needs a decision, a formula that needs the very thing another ticket defines. Read the Question and wire **all** of them: miss one and the ticket surfaces on the frontier prematurely and gets worked before its prerequisite. Then wiring a blocker is **three moves**: (1) list *which* tickets block in the `## Blocked by` body section (name+link); (2) create the **native GitHub dependency** so the frontier renders visually in GitHub's own UI: `gh api --method POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker's internal .id>`; (3) add the **`trailhead:blocked`** label. The **label is the frontier's source of truth**: native dependencies aren't cheaply queryable in one search, so the label is what keeps the frontier **one query**. On unblock, **remove the label the moment the last blocker closes** (that's what graduates the ticket onto the frontier); the native edge needs no cleanup: GitHub auto-reflects a closed blocker. **The three moves are one fact in three views: they must name the *same* blocker.** The `## Blocked by` line must link the **real blocker ticket** the native edge targets (its actual number), never a superseded parent, a split-origin, or a by-role placeholder like "child A"; wire the prose line and the native dependency in the same pass, from the same id, so they can't drift. |
| Claim | assign the ticket to yourself: `gh issue edit <n> --add-assignee @me`: the assignee *is* the claim; the claimer owns it end to end and closes it (no approver). Re-check before starting; on a collision, stop and ask the user. See [Working as a team](#working-as-a-team). |
| Resolution | comment with the answer → `gh issue close` → update `Decisions so far` on the map |

**State labels** (orthogonal to the type label, on top of `trailhead:ticket`):
- **`trailhead:blocked`**: has an open blocker; excluded from the frontier. Removed when unblocked.
- **`trailhead:seed`**: a forward-looking capture parked until a trigger fires (kept blocked); makes seeds auditable.
- **`trailhead:out-of-scope`**: closed because ruled beyond the destination, *not* resolved; keeps it distinct from resolved tickets and out of `Decisions so far`.
- **`trailhead:superseded`**: closed because split into child tickets that replace it (see [Working as a team](#working-as-a-team)); *not* resolved, and out of `Decisions so far`.
- **`trailhead:unverified`**: a `trailhead:*` issue whose provenance isn't trusted (see [Trust & provenance](#working-as-a-team)); quarantined off the frontier until a maintainer adopts or rejects it.
- **`trailhead:fog`**: an in-scope-but-not-yet-sharp issue (usually an inbound suggestion) **kept open as a clarification space** (visible and tracked, off the frontier and out of the inbox) where the reporter and others discuss until it's sharp enough to graduate into a ticket. See [Inbox](#inbox-issues-opened-by-others).

**Frontier** = open, unassigned tickets that are **not** `trailhead:blocked` and **not** `trailhead:unverified`. That's the whole query: the labels are the pre-computed answers to "are all blockers closed?" and "is this a trusted trailhead ticket?", so no per-ticket body parsing.

**Blocked-by reconciliation (drift check).** The `## Blocked by` prose and the native dependency are two copies of one fact, so they can drift (it has happened: a body naming the split-*origin* while the native edge pointed at the sibling). When rendering `/trailhead:map` and before working a ticket, **reconcile them deterministically**: parse the issue numbers in the ticket's `## Blocked by`, read its native `blocked_by` (`gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by`), and if the two sets differ, **surface an advisory** naming both sides (the native edge is the structured reference); never auto-fix, never block. If the body has no parseable `## Blocked by`, report it **uncheckable**, never assume they agree. This is the one deterministic, false-positive-free consistency axis; higher-level "does a ticket contradict the map's decisions" drift is left to human judgement.

Base commands:
```bash
# create the map
gh issue create --label "trailhead:map" --title "<destination>" --body-file <body>
# create a child ticket (add trailhead:blocked too if it has an open blocker)
gh issue create --label "trailhead:ticket,trailhead:build" --title "<question/goal>" --body-file <body>
# wire a blocker: native dependency (visual frontier in the UI) + the label (the query)
gh api --method POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id=$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)
gh issue edit <blocked> --add-label "trailhead:blocked"
# the frontier: open, unassigned, not blocked, not unverified, one query
gh issue list --label "trailhead:ticket" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
# unblock a ticket once its last blocker closes (label only; native edge auto-reflects)
gh issue edit <n> --remove-label "trailhead:blocked"
# claim
gh issue edit <n> --add-assignee @me
# resolve
gh issue comment <n> --body-file <resolution>   &&   gh issue close <n>
```
**First-use repo setup (do BOTH, every chart or adopt, never skip either):**
1. Create any missing labels with `gh label create` (all sixteen: `trailhead:map`, `trailhead:codebase`, `trailhead:conventions`, `trailhead:ticket`, the six type labels, `trailhead:blocked`, `trailhead:seed`, `trailhead:out-of-scope`, `trailhead:superseded`, `trailhead:unverified`, `trailhead:fog`).
2. **Check the label guard is installed**: `gh api repos/{owner}/{repo}/contents/.github/workflows/trailhead-label-guard.yml`; if it's absent (404), install it: **read `references/teamwork.md` (Trust & provenance → Repo-side enforcement) for the exact steps**. This is part of standing up trailhead in a repo, not an optional extra: *check every time*, so a repo can never end up with the labels but no guard.

## The Map

A single `trailhead:map` issue, the canonical artifact. It's an **index**, not a store: it lists the decisions made and points at the tickets that hold their detail. A decision lives in exactly one place (its ticket); the map gists it and links.

**`/trailhead:map`** renders this at low resolution as a read-only dashboard (it changes nothing), the map body plus the live ticket state, by name:
- **Destination**: the one-line where-we're-headed.
- **Frontier**: takeable now (open, unassigned, not blocked/unverified), each with its type.
- **In progress**: claimed tickets, with who holds each.
- **Blocked**: with what each waits on; flag any **blocked-by drift** (prose `## Blocked by` ≠ native dependency, see [Blocked-by reconciliation](#substrate-github-issues)) as an advisory line.
- **Decisions so far**: the index of what's settled.
- **Not yet specified** + **parked fog**: the coarse fog, and a count/link of open `trailhead:fog` issues.
- **Out of scope**: what's been ruled out.
- **Inbox**: a count of untriaged inbound issues, as a nudge.

Map body (loaded once per session):

```markdown
## 🎯 Destination
<what reaching the end of this map looks like: the spec, decision, or change this effort tends toward. The working artifact, unless overridden. One or two lines; every session orients to it before choosing a ticket.>

## 🗒️ Notes
<domain; vocabulary (see Domain vocabulary); standing preferences for this effort; any "stop at the spec" override; a **link to the repo's `trailhead:codebase` issue** (the codebase map lives there, repo-scoped, never re-inline it here) and a **link to the repo's `trailhead:conventions` issue** (the way of working: git/release + notes). Config is NOT here either: it lives in `.trailhead/config.json` at the repo root; see Configuration.>

## ✅ Decisions so far
<!-- the index: one line per closed ticket -->
- [<closed ticket title>](link): <one-line gist of the answer>

## 🌫️ Not yet specified
<!-- fog of war: in-scope fog not yet ticketable; graduates as the frontier advances -->

## 🚫 Out of scope
<!-- work ruled beyond the destination; closed, never graduates -->
```

Section names are matched by their **text**: the emoji are cosmetic anchors, so `Decisions so far` / `Not yet specified` / `Out of scope` still refer to these blocks throughout.

## Configuration

Three layers, **nearest wins**, key by key; a key unset at one layer inherits the next:
- **Project**: a `.trailhead/config.json` file at the repo root: overrides for this project, committed so a team shares one config. **Config never lives in the map issue**: the map is an index of decisions, while config is the user's to change at any time, so it stays in a plain file (and never asserted into the map by the agent).
- **Global**: `~/.claude/trailhead/config.json` (honour `$CLAUDE_CONFIG_DIR`): your standing defaults across every project.
- **Defaults**: the built-in values documented in `references/configuration.md`.

Load the effective config at the start of a work session. **The main session orchestrates and holds the HITL moments** (the `build`/`bug` Discuss's "stop and ask", Verify's acceptance/UAT); **every model key runs as a subagent** (`plan`, `execute` (an *executor subagent* implementing with atomic commits on `models.execute`), `research`, `review`, `debug`) so the whole per-activity model split applies in one session whatever model it runs on. Run Execute inline only when `models.execute` is unset or equals the session model. The **keys, their values, the model/tdd/acceptance semantics, and the guided menu setup live in `references/configuration.md`**: read it when running `/trailhead:config` or when you need a key's exact meaning. `/trailhead:config` with no args runs the guided setup; `config get` prints the merged config; `config set <key> <value>` writes one key.

**Ticket language (standing engine rule).** Write **all human-authored trailhead prose on the Issues** (ticket titles and bodies, every engine comment (`DISCUSS`/`PLAN`/`VERIFY`/`OPTIONS`/`REPRO`/`DIAGNOSIS`/`PAUSED`/resolution), and the map body sections) **and commit message descriptions** in `config.ticket.language` (ISO 639-1, default `en`). The conventional-commit **type prefix stays English** (`feat:`/`fix:`/…). This is **independent of the language the agent converses in** and never changes it; likewise it never touches code, identifiers, the fixed `trailhead:*` label names, or config keys/values. The skill's own source docs stay English regardless.

## The Tickets

Each ticket is a child issue. Its **title carries the type icon** (see below); the body stays lean, one Question, sized to one ~100K-token session:

```markdown
Title: 🐛 <clear, specific title>

**Parent:** [<map name>](link)

## Question
<the decision, investigation, or build goal this ticket resolves>

## Blocked by
<!-- names+links of tickets that must close first; empty → write "nothing (on the frontier)" -->
```

The answer isn't in the body: it's recorded on resolution as a comment. Assets created while resolving a ticket are linked from the issue, not pasted in.

**Visual style.** Tasteful icons for scannability, never at the cost of the lean body. The **type icon** prefixes the ticket title and appears wherever tickets are listed (`/trailhead:map`, inbox):

| Type | Icon | | Map section | Icon |
|---|---|---|---|---|
| `decision` | 🧭 | | Destination | 🎯 |
| `research` | 🔬 | | Notes | 🗒️ |
| `prototype` | 🎨 | | Decisions so far | ✅ |
| `build` | 🔨 | | Not yet specified | 🌫️ |
| `bug` | 🐛 | | Out of scope | 🚫 |
| `task` | 🔧 | | | |

The map issue title is prefixed 🗺. Keep the icons stable and don't add others: they're anchors, not decoration.

## Techniques

The ticket engines call these by name. Each technique's full protocol lives in its own file under `references/techniques/`: **read that file the first time a session needs the technique**, so only the ones in play load into context (don't preload them). They are `trailhead`'s own, self-contained (distilled from Wayfinder and GSD); subagents are spawned with the built-in `Agent` tool.

| Technique | File | In one line |
|---|---|---|
| **Grilling** | `references/techniques/grilling.md` | interrogate the human, one question at a time, to converge on a decision |
| **Domain vocabulary** | `references/techniques/domain-vocabulary.md` | build a precise shared glossary so each term means one thing |
| **Prototype** | `references/techniques/prototype.md` | throwaway artifact for "how should it look/behave"; routes UI mockups (disk / claude.ai/design) |
| **Research** | `references/techniques/research.md` | a focused subagent gathers a decision-ready fact from primary sources |
| **TDD** | `references/techniques/tdd.md` | RED → GREEN → REFACTOR at the seams; no implementation before a failing test |
| **Codebase map** | `references/techniques/codebase-map.md` | one-time fan-out of 5 read-only readers, distilled into the repo's `trailhead:codebase` issue |
| **Debug** | `references/techniques/debug.md` | scientific method: reproduce → localise → falsifiable hypotheses → confirm cause → verify |
| **Code review** | `references/techniques/code-review.md` | review the diff on 4 axes, adversarially verify each finding before reporting |
| **Acceptance testing** | `references/techniques/acceptance-testing.md` | prove it does what the *user* wanted: automated → browser-drive → guided UAT |
| **Cross-AI plan review** | `references/techniques/plan-review.md` | send a PLAN to external AI CLIs, converge on their concerns (opt-in via `config.plan_review`) |

## Ticket types and their engine

Every ticket is **HITL** (human in the loop, speaking for themselves) or **AFK** (driven by the agent alone). A HITL ticket resolves only through the live exchange: the agent never stands in for the human's side.

### `decision`: HITL, *default for decision tickets*
Close a choice, but widen before you narrow:

1. **Diverge (only if the option space isn't already clear).** Mapping the frontier usually framed the options already; skip straight to grilling when it did. When it didn't (the ticket names a question but the candidate answers aren't laid out) open the space *first*: brainstorm the plausible options, name each concretely, and post them as an `OPTIONS` comment. Divergence has no judgement yet: surface possibilities, don't rank them. If a missing **fact** is what's blocking clarity, spin a `research` ticket and block on it; if the question is "how could it look/behave", spin a `prototype`. Don't grill a space you haven't opened.
2. **Converge.** Run the **Grilling** + **Domain vocabulary** techniques over the options to pick one. Record the decision and the why.

The two phases are distinct on purpose: divergence generates, grilling chooses. Never let the agent invent the options *and* pick for the human: the choice stays theirs.

### `research`: AFK
Reading docs, third-party APIs, or local resources to surface a fact a decision waits on. Resolved by the **Research** technique. The only type that runs in parallel and more than one per session.

### `prototype`: HITL
Raise the fidelity of the discussion with a rough, concrete artifact to react to: the **Prototype** technique. Link the prototype as an asset.

### `build`: the engine inside the map
The ticket that *builds*. Lean cycle, all in **ticket comments**:

1. **Discuss**: **never auto-grill.** Start from Plan. If reading the ticket surfaces blocking ambiguity, **stop and ask the user** whether they want a **Grilling** round: don't launch it on your own initiative. Only on their assent run the short round and post a `DISCUSS` comment with the closed choices. The user may also ask for it themselves at any time.
2. **Plan**: a `PLAN` comment: the steps, the seams, the files touched, the verification criteria. Apply **TDD** per `config.tdd` (`seams`/`on`/`off`). Produce this plan via a *planner subagent* on `config.models.plan` (inline when it's unset or equals the session model; Execute then runs as its own subagent, see below). If `config.plan_review` is on, run **Cross-AI plan review** before Execute: send the plan to external AI CLIs and converge on their concerns. Now that the files/seam are known, run the [undeclared-coupling check](#working-as-a-team) against in-progress tickets.
3. **Execute**: implement with **atomic commits** (conventional commits), following the repo's `trailhead:conventions` `git:`, straight to `main` by default, or a feature branch + PR when `git: pr`. **Under `isolation: worktree`, do the work in this ticket's `git worktree`** (`trailhead/t<n>` branch), integrating to the trunk at Resolve (see [Working as a team](#working-as-a-team)). One commit = one verifiable step. Run this via an **executor subagent on `config.models.execute`** (inline when it's unset or equals the session model); the commits land on `main`, visible. New scope surfacing mid-execute is captured/split, not worked here.
4. **Verify**: a `VERIFY` comment: run the tests / the plan's criterion; then the **Code review** technique (its subagent reviews *adversarially*: it doesn't defer to a `CLAUDE.md` convention or a "settled decision" memory); then **Acceptance testing** if the change is user-facing (browser-drive it, or **walk the user through a guided UAT conversationally, one step at a time**, never a checklist dumped in a comment). Report the outcome honestly (if a test fails, say so).
5. **Resolve**: a resolution comment with what was done → `gh issue close` → update `Decisions so far` on the map. Then close the session with the **[Session handoff](#session-handoff)** ritual (`/clear` + next command).

New scope that surfaces mid-build (while planning, executing, or testing) → **capture or split, never expand this ticket in flight** (see [Scope that surfaces while working a ticket](#capture-zero-friction--tracker)).

### `bug`: the fix with diagnosis first
A defect to correct. Unlike `build`, you don't start from implementation: first you **understand**.

**New bug ticket vs reopen: decide first.** A bug in the work of an already-closed ticket almost always means a **new** `bug` ticket, *not* reopening the old one, because `Decisions so far` is append-only history: that ticket really did deliver, and the defect surfaced later is a new event. The one exception is a **premature close**: a ticket closed before its Verify ever passed, i.e. it never actually delivered. The discriminator is sharp: **did that ticket genuinely pass Verify?**
- **Yes** → new bug ticket carrying `Regression of: <closed ticket name+link>` in its body. Leave the original closed. Open it with `/trailhead:bug --of <ticket> <text>` (below), which fills the pointer for you.
- **No** (closed by mistake, never delivered) → this isn't a new bug, it's a bad close: `gh issue reopen <n>` and finish it.

Then run the cycle, all in ticket comments:

1. **Repro**: a `REPRO` comment: how to reproduce, expected vs observed behaviour.
2. **Diagnose**: run the **Debug** technique. A `DIAGNOSIS` comment with the root cause.
3. **Fix**: implement the correction with **atomic commits** (per the repo's `trailhead:conventions` `git:`, `main` by default, else a branch + PR; in this ticket's `git worktree` under `isolation: worktree`), via an **executor subagent on `config.models.execute`** (inline when unset/same as session). Where sensible, a test that fails before and passes after (**TDD**).
4. **Verify**: a `VERIFY` comment: the repro now passes, no regressions; **Code review** on the fix; **Acceptance testing** if the bug was user-facing (browser-drive the fixed flow, or **walk the user through a guided UAT conversationally, step by step**, not a checklist to self-serve).
5. **Resolve**: a resolution comment (cause + fix) → `gh issue close` → update `Decisions so far`. Then close the session with the **[Session handoff](#session-handoff)** ritual (`/clear` + next command).

A **blocking** bug that halts other work is worked immediately; an isolated one is a normal frontier ticket. New scope surfacing while fixing → capture or split, never expand this ticket in flight (see [Scope that surfaces while working a ticket](#capture-zero-friction--tracker)).

### `task`: HITL or AFK
Manual work that must happen before a *decision* can be made: signing up for a service to judge its API, provisioning access, moving data to see its shape. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and the resulting facts (where credentials live, new URLs, row counts) later tickets depend on.

## Fog of war

The map is *deliberately* incomplete: don't chart what you can't yet see. Beyond the live tickets lies the fog: decisions and investigations you can feel coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating into fresh tickets whatever has become specifiable, one at a time, until the way to the destination is clear and no tickets remain.

**Not yet specified** is where that dim view is written: the suspected question, the area to revisit. Everything here is in scope, just not sharp enough for a ticket.

**Fog or ticket?** The test is whether you can *phrase* the question precisely now, not whether you can *answer* it now.
- **Ticket** when the question is already sharp, even if blocked.
- **Not yet specified** when you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces.

## Out of scope

Fog only ever gathers *toward* the destination. Work beyond the destination is **out of scope**: it isn't fog, it doesn't belong in *Not yet specified*. It gets its own section on the map. It never graduates: the frontier stops at the destination. When an existing ticket turns out to sit beyond the destination, label it **`trailhead:out-of-scope`**, **close it**, and leave one line in *Out of scope* with the why, linking the closed ticket. The label keeps it distinct from a resolved ticket; it stays out of *Decisions so far*, which records the way actually walked.

## Capture (zero friction → tracker)

Capture without breaking flow, to the **tracker** (not scattered files). One capture = one action + one confirmation line; it **resolves nothing**. The verbs are in the **Capture** table under [Commands](#commands); their per-verb detail and the **note · idea · seed · todo** commitment/timing spectrum (raw text → fog → gated ticket → frontier ticket) are in **`references/capture.md`**: read it when a capture verb needs more than the one-line gist.

**Scope that surfaces while working a ticket.** Testing or building X often sparks new ideas: do **not** grow X in flight; a ticket is one answerable Question, sized to one session. Decide per idea:
- part of X's Question and small → just do it in X (that's completing X, not expanding it);
- it balloons X past one session → **`split`** X (children carry the new pieces, supersede the original);
- separate work or a follow-up beyond X's goal → **capture and continue** (`idea`/`todo`/`ticket`/`bug --of X`), don't derail.

Tickets born this way carry a **`Surfaced from: <ticket name+link>`** line in their body (the same lineage convention as `Split from:` and `Regression of:`) so where an idea came from stays visible. Never let extras become silent lines inside X: the map stays honest by spinning them into their own tickets or fog.

## Working as a team

Many people (and their sessions) share one map concurrently; the tracker is the single source of truth. **Claiming (needed every time you work a ticket):** assign it to yourself before any work (`gh issue edit <n> --add-assignee @me`), re-read the assignee right before starting, and on a **collision stop and ask the user**: never resolve it silently; unclaim if you stop; never touch a ticket someone else holds. Whoever claims a ticket owns it end to end and closes it (no approver).

The rest of the concurrency protocol lives in **`references/teamwork.md`**. Read it when you do that thing: **pausing & resuming** (`PAUSED` checkpoints, release vs keep the claim), **splitting** an oversized ticket (children + supersede + re-point blockers), the **undeclared-coupling** check between parallel tickets, safe **concurrent map-body edits**, and **trust & provenance** (the trust rule, the `trailhead:unverified` quarantine, and installing the repo-side **label guard** at first-use).

## Inbox: issues opened by others

`/trailhead:inbox [issue]` triages issues opened by others (bug reports, requests, questions that aren't trailhead tickets) and integrates the worthwhile ones **in place**: reframing them as tickets, keeping the reporter's authorship, applying the labels on adoption; the rest routes to fog, out-of-scope, duplicate, or needs-info. It also surfaces **parked `trailhead:fog`** whose thread went quiet-then-active: that's how you notice a fog has cleared. **Full protocol (the two triage sections, the adopt/fog/out-of-scope/duplicate/needs-info routing, the `trailhead:unverified` handling) in `references/inbox.md`**: read it when running inbox.

## Invocation

### Mode 1: Chart the map (new project), `/trailhead:new`
The user invokes with a loose idea.

1. **Name the destination.** Run the **Grilling** + **Domain vocabulary** techniques to pin down what this map tends toward. The destination fixes the scope, so it's settled first. Default: a working artifact.
2. **Map the frontier.** Grill again, **breadth-first**: fan out across the whole space rather than deep on one thread, surfacing the open decisions and the first steps takeable now. **If no fog surfaces** (the way is already clear, the whole thing fits one session) you don't need a map: stop and ask how to proceed.
3. **Create the map** (`trailhead:map`): Destination and Notes filled in, Decisions-so-far empty, the fog sketched into *Not yet specified*. Run the [first-use repo setup](#substrate-github-issues) now: labels **and** the label-guard check/install. Then set up **conventions**: if no `trailhead:conventions` issue exists, run a **brief conventions brainstorming** (breadth-first, in the spirit of grilling but short: a handful of questions, not a full session) to surface the project's way of working: `git:` `main`|`pr`, `release:` `command`|`auto`, and `isolation:` `none`|`worktree` (the header, the last asked as *"will more than one session run on a single clone at once?"* → `worktree`; a monorepo leans `worktree`), **plus** the narrative a new contributor would need: release/deploy specifics (environments, manual steps, OTA vs full build, versioning), tooling that must be driven a certain way (a specific MCP/CLI, e.g. a Lovable project piloted via its MCP), code & style rules, testing/UAT norms. Distil into the issue (header + prose); link it from the map's Notes. Don't invent: leave out or ask what you can't determine. If one already exists, just link it (reuse across maps).
4. **Create the tickets you can specify now** as child issues, then wire the blocking in a **second pass** (issues need ids before they can reference each other): for each ticket **read its Question and wire a blocker for every still-open ticket whose output it consumes** (don't stop at the first/obvious one), then run the three-move wiring (`## Blocked by` line + native dependency + `trailhead:blocked` label, see [Substrate](#substrate-github-issues)). Wiring sorts them into frontier (unlabelled) and blocked; the rest stays fog.
5. **Fire the research subagents.** For each `research` ticket created, run the **Research** technique in parallel, findings on a `research/<name>` branch with a pointer from the ticket.
6. **Offer config, then stop.** Charting is one session's work; it hand-resolves nothing. Before ending, make the **first-time config offer** (see [smart entry](#commands)): the project now has a fresh map and no `.trailhead/config.json`, so offer `/trailhead:config` once (or *continue on defaults*, which writes `{}`) so it's handled while you're setting up. Once the file exists it's never offered again.

### Mode 1-bis: Adopt an existing project, `/trailhead:adopt`
When the code already exists (project in progress). Like Mode 1, but start from **reality**, not a blank page. One heavy step at entry, then all lean.

1. **Map the codebase (once per repo).** Heavy step, *only* at adoption: it does not repeat per ticket, and **not per map**. First check for an existing **`trailhead:codebase`** issue: if one exists (an earlier map on this repo created it) and the code hasn't materially drifted, just **link it** from this map's Notes and skip the fan-out. Otherwise run the **Codebase map** technique (a parallel fan-out of reader subagents) for a structured understanding (architecture, stack, decisions already embodied, risk areas) and distil the essence into the repo's **`trailhead:codebase` issue** (create it, label `trailhead:codebase`), then link that issue from the map's Notes. Discard the raw. Because it's a standalone repo-scoped issue, the next map reuses it instead of re-deriving or losing it.
2. **Name the destination of the remaining stretch.** **Grilling** + **Domain vocabulary**, **seeded by the map you just built**: not "what is the project" but "what's left to reach working / the next milestone".
3. **Backfill the decisions already made.** Choices already embodied in the code (now visible from the map) or stated by the user go into `Decisions so far` as **ticket-less** lines (they're already closed), so the map reflects reality and doesn't pretend greenfield. Link to code/commits where useful.
4. **Map the frontier of the remainder** → tickets specifiable now + fog in *Not yet specified*, then wire the blocking and fire the research. As Mode 1, steps 4–6.

The tracker is the existing repo's (`gh` in its directory); run the [first-use repo setup](#substrate-github-issues) on first use (missing `trailhead:*` labels **and** the label-guard check/install (adopting an existing repo is exactly when the guard tends to be missing)) and set up the `trailhead:conventions` issue via a **brief conventions brainstorming** (see Mode 1 step 3), but here, **seed the questions from what's discoverable** so you confirm rather than ask blind: an existing `CLAUDE.md`/`AGENTS.md`, CI workflows, the PR-vs-`main` git history, package scripts, deploy config. **Detect a monorepo** (a `pnpm-workspace.yaml`, a `workspaces` field, an `nx.json`/`turbo.json`, or several packages under `packages/`|`apps/`) and, if found, propose `isolation: worktree` and note that tickets should carry a `Scope:` line, **unless the buildable units are path-bound** (see below). **Detect git submodules** (a `.gitmodules` file) and, if found, add the prose rule that submodule work is committed **inside the submodule + a gitlink bump in the parent**, isolated at the submodule (not the superproject); a submodule path is a natural `Scope:` (see [Working as a team](#working-as-a-team)). **Before proposing `worktree`, check for path-bound tooling** (a React Native/Expo app, native toolchains, a package whose build depends on a local `node_modules`/bundler cache/absolute-path config): those don't build from a worktree, so for them propose **`isolation: clone`** (a per-ticket clone that installs its own deps and builds), or `isolation: none` + **serialize** if the user doesn't want per-ticket clones. Worktree is for units that build from any path. Propose the values you inferred and let the human correct/complete them; create the issue if absent, link it from the map's Notes.

### Mode 2: Work the map, `/trailhead:work`
The user invokes with a map (URL or number). A ticket is optional: without one, you pick the next decision.

1. Load the **map** (the low-res view, not every ticket body).
2. Choose the ticket. If the user names one, use it. Otherwise the first frontier ticket in order. **Claim** it: assign it to yourself before any work, then re-read the assignee before starting; on a collision, stop and ask the user (see [Working as a team](#working-as-a-team)). If the ticket proves too big once you're in it, **split** it rather than grind (same section).
   - **First, if the conventions header has NO `isolation:` key at all** (never chosen, so silently defaulting to `none`), sanity-check it **once** before working: if there's a real collision risk, don't just work the shared checkout. The risk signals are **another in-progress ticket** (a concurrent session is plausible) or **path-bound tooling in this ticket's `Scope:`** (a React Native/Expo app, native toolchain, a local `node_modules`). On a signal, surface a one-line suggestion naming it and the fitting mode (`worktree` for builds that run from any path, `clone` for path-bound apps) and offer to set it now. Whatever the user picks (**including "keep `none`"**), **write the `isolation:` key into the conventions issue** so the choice is recorded and this never prompts again. If the key is already present (any value, `none` included), it was chosen: respect it and skip this check. This is the one convention worth surfacing (it changes where you work); don't nag beyond writing the key once.
   - **Under `isolation: none`, check the scope is free before starting** (this is how a submodule/package gets serialised when worktrees don't fit): scan the other in-progress tickets' `Scope:` lines, and if one **overlaps** this ticket's scope, **stop and tell the user** the scope is busy (name the ticket + holder) and offer a disjoint-scope frontier ticket or to wait. See [Working as a team](#working-as-a-team).
   - **Under `isolation: worktree` or `clone`, set up the isolated workspace NOW, before any file edit or diagnostic probe** (not later at Execute/Fix): for `worktree`, create/enter this ticket's `git worktree` on a `trailhead/t<n>` branch for the repo the ticket's `Scope:` points at (**the submodule itself for submodule-scoped work**, e.g. `git -C app worktree add ../<repo>-t<n> -b trailhead/t<n>`); for `clone`, make an independent working copy at `../<repo>-t<n>` (branch `trailhead/t<n>`) by whichever is faster: `git clone` + the install step, or a **folder copy that brings `node_modules`** to skip the reinstall (then verify the copy's git is independent, `git -C <copy> rev-parse --absolute-git-dir` resolves inside it, else commits leak back to the original). Do every subsequent step there. This is the whole point of isolation: if you diagnose and edit in the shared checkout "just to start", a concurrent session is already colliding with you. Do it silently (don't narrate it); it's undone at Resolve when the branch integrates and the worktree/clone is removed. See [Working as a team](#working-as-a-team).
3. Resolve it with its type's engine, **zoom as needed**: fetch the full body of related/closed tickets on demand. If in doubt on a `decision` ticket, run **Grilling** + **Domain vocabulary**. If in doubt on a `build`, **stop and ask** (see the Discuss step): never auto-grill.
4. Record the resolution: a comment with the answer, `gh issue close`, add the pointer to *Decisions so far*. Then **unblock dependents**: for every ticket this one was blocking, if it was the last open blocker, remove its `trailhead:blocked` label so it graduates onto the frontier.
5. Add newly-surfaced tickets (create-then-wire, labelling blocked ones `trailhead:blocked`); graduate the fog that became specifiable, clearing the patch from *Not yet specified*. If the answer reveals a ticket sits beyond the destination, **out of scope** (label + close) instead of resolving it. If the decision invalidates other parts of the map, update or delete them.
6. **Hand off.** Close the session with the **[Session handoff](#session-handoff)** ritual: confirm the ticket is resolved by name, then the scannable **next-step block with `/clear` first** (never the next command without it), naming the next frontier ticket and giving its number, or `/trailhead:map` if the frontier is empty/ambiguous. This holds in any later follow-up too, not only at the moment of resolution. **If this resolution leaves the map exhausted** (no open tickets and no fog left: the destination is reached), say so and **unpin the map** (see [Substrate](#substrate-github-issues), the pin lifecycle); codebase and conventions stay pinned.

### Mode 3: Capture, `/trailhead:bug|todo|idea|seed|note`
The user fires a capture on the fly → route it per the **Capture** section and confirm with one line.

### Auxiliary verbs: `/trailhead:ticket|config|grill|split|pause|resume`
- **`ticket <type> <title>`**: open ticket(s) of the map on the fly, for any of the six types (`decision`, `research`, `prototype`, `build`, `bug`, `task`), the escape hatch the capture verbs don't cover. **Adding a ticket is a micro-charting act, so diverge briefly first, don't blind-commit to a single piece:** run a short breadth-first pass around the request: is this really *one* session-sized ticket, or a small **cluster** (a `decision` that needs a `research` before it, a UI `build` that needs a `prototype`, obvious siblings)? Does it imply a blocker? Surface the neighbours, *then* create the ticket(s): each gets `trailhead:ticket` + its `trailhead:<type>`, a `Parent:` line, a `## Question`; put each on the frontier, or wire `## Blocked by` + `trailhead:blocked`. This is a framing brainstorm (is this the right work?), distinct from the `decision` engine's option brainstorm (which choice?). If `<type>` is missing or invalid, ask which of the six. *(The zero-friction captures, `bug`/`todo`/`idea`/`seed`/`note`, deliberately skip this; they're one action, one confirmation.)*
- **`grill [topic|ticket]`**: run a standalone **Grilling** (+ **Domain vocabulary**) session on a decision or topic, or on a named ticket, without committing to the full work cycle. Record the outcome where it belongs: a ticket's resolution, the map's `Decisions so far`, or a fresh `decision` ticket.
- **`config`**: a **guided, menu-driven** setup (see [Configuration → Guided setup](#configuration)): pick the scope, then walk each setting as an `AskUserQuestion` menu with icon-labelled options, and write the result. `config get` prints the effective config read-only (project `.trailhead/config.json` merged over global over defaults, showing which source wins each key); `config set <key> <value>` writes one key directly: to the project `.trailhead/config.json`, or to `~/.claude/trailhead/config.json` with `--global`.
- **`split [ticket]`**: split the named (or in-play) ticket per [Splitting a ticket](#working-as-a-team): create children, supersede & close the original.
- **`pause [note]`** / **`resume [ticket]`**: checkpoint and pick back up per [Pausing & resuming](#working-as-a-team).

The user may work unblocked tickets in parallel: expect concurrent sessions editing the tracker, see [Working as a team](#working-as-a-team) for claiming, splitting, and safe map edits.
