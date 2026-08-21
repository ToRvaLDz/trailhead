---
name: trailhead
description: "Start and drive a large project (more than one agent session can hold) as a map of decision tickets on GitHub Issues, resolving one at a time until the way to the destination is clear. Self-contained: map-based onboarding and a discuss→plan→execute→verify engine with atomic commits, with everything (map, discussion, plan, verification) living on the Issues. No dependencies beyond an authenticated gh CLI. Invoke only when the user explicitly runs `/trailhead` (or a `/trailhead:<verb>` command) or asks to chart, adopt, or work a trailhead map, and do not auto-invoke for generic planning, project, or task-tracking requests."
argument-hint: "[new|adopt|work|ticket|inbox|map|config|grill|split|pause|resume|bug|todo|idea|seed|note] [text | ticket]"
---

A loose idea has arrived, too big for one session: the way from here to the **destination** isn't visible yet. `trailhead` is where the trail begins. It charts the way as a **shared map on GitHub Issues**, then works its **tickets**, one at a time, until the road is clear and the destination reached.

The method fuses two halves; `trailhead`'s core invokes no other skill and depends on nothing but an authenticated `gh` CLI (the one opt-in exception: `claude.ai/design` mockup mode uses **DesignSync** (the `claude_design` MCP + `/design-sync` skill) to push to a design-system project, and falls back to disk if it's unavailable):
- **The map.** Question-driven onboarding, the destination named first, the frontier, the fog of war, reference *by name*, one ticket per session.
- **The engine.** Zero-friction capture and the `discuss → plan → execute → verify` cycle with atomic commits that resolves each build ticket *inside* the map.

The techniques commonly packaged as separate skills (grilling, TDD, systematic debugging, codebase mapping, code review) are **built in here as inline protocols** (see [Techniques](#techniques)). `trailhead` is self-contained.

**Everything lives on the Issues.** No `.planning/`: the map is the parent issue, each ticket is a child issue, and discussion / plan / verification are **comments** on the ticket. The repo holds code only.

## Requirements

Only an **authenticated `gh` CLI**: the tracker is GitHub Issues. Nothing else to install. The subagents `trailhead` spawns (research, codebase-map, review) use the built-in `Agent` tool; every technique is defined inline below.

## Commands

The **first word** of `$ARGUMENTS` is the verb; the rest is the text (or a ticket number). With no verb, `/trailhead` does **smart entry**: it detects the repo state and proposes (no map → offer *chart* or *adopt*; map present → *work* the next frontier ticket).

**First-time config offer (once per project).** When a project has a map but **no `.trailhead/config.json` yet**, smart entry puts an **explicit two-way choice** to the user and waits for their pick: **(a) accept as-is** (continue on the current/proposed values, which writes an empty `{}`), or **(b) run `/trailhead:config`** to configure everything through the guided menu (models/design/TDD/…). **Always name both paths and let the user choose; never silently take one.** You may show the values you'd default to, but frame the close as this binary: **do not** pre-fill the config keys and ask for an open-ended inline edit ("ok tutto oppure le modifiche"), and **do not** interview the user key-by-key inline (that's exactly what `/trailhead:config`'s menu is for). Ask this **only once**: running config writes the file, and *accept as-is* writes an empty `{}`, so once `.trailhead/config.json` exists it's never offered again (a `{}` file means "reviewed, using defaults"). The same offer is made at the end of chart/adopt (Mode 1/1-bis). It fires on the bare `/trailhead` and when setting a project up, never in the middle of working a ticket.

Every verb is also a **namespaced command** (`/trailhead:new`, `/trailhead:work`, `/trailhead:bug`, …) so typing `/trailhead` lists them all in the picker. They're thin wrappers that delegate here; `/trailhead <verb>` and `/trailhead:<verb>` are equivalent.

**Flow**
| Command | What it does |
|---|---|
| `/trailhead` | smart entry: detect and propose |
| `/trailhead:new [idea]` | chart a new map → Mode 1 |
| `/trailhead:adopt` | adopt an existing project → Mode 1-bis |
| `/trailhead:work [ticket]` | work the map: the next frontier ticket, or the one you name → Mode 2 |
| `/trailhead:quick [ticket \| "text"]` | work one ticket whole, off the map: `quick "text"` opens a whiteboard ticket and works it now, `quick <n>` works an existing one; full engine, grills only if needed, never splits |
| `/trailhead:whiteboard` | show the whiteboard: the loose (map-less) tickets, their frontier and who holds each |
| `/trailhead:inbox [issue]` | triage issues opened by others and integrate the worthwhile ones into the map |
| `/trailhead:resume [ticket]` | resume a paused ticket: read its latest `PAUSED` checkpoint and continue |
| `/trailhead:pause [note]` | checkpoint the ticket in play so it can be resumed later (by you or anyone) |
| `/trailhead:split [ticket]` | split an oversized ticket into children and supersede the original |
| `/trailhead:ticket <type> <title>` | open one child ticket of the map on the fly (`type` = decision\|research\|prototype\|build\|bug\|task) |
| `/trailhead:grill [topic]` | run a standalone grilling session on a decision/topic (or a named ticket) |
| `/trailhead:map [map]` | show the low-res map (destination, decisions, frontier, fog); with several maps open, `[map]` picks one and makes it active, or lists them to choose (see [Multiple maps](#multiple-maps-on-one-repo-parking--concurrency)) |
| `/trailhead:config [get\|set …]` | show the effective config (global + project), or set a key |
| `/trailhead:update` | check for a newer trailhead and install it where safe (see `references/updating.md`) |

**Capture** (zero friction, one confirmation line, resolves nothing → Mode 3):
| Command | Destination |
|---|---|
| `/trailhead:bug [--of <ticket>] <text>` | a `trailhead:bug` ticket on the frontier; `--of` records it as a `Regression of: <ticket>` |
| `/trailhead:todo <text>` | a small ticket on the frontier: work you *will* do |
| `/trailhead:idea <text>` | a line in *Not yet specified* (the fog); a ticket only if already razor-sharp |
| `/trailhead:seed <text>` | a blocked ticket with its trigger noted in `## Blocked by` |
| `/trailhead:note <text>` | a verbatim note (fog; outside a project → `$HOME/.claude/notes/`) |

Missing text in a capture → ask for the line. Unrecognised verb → treat the whole string as `idea`.

**Idea vs todo:** `idea` is a maybe-later thought (fog by default, graduates when the frontier reaches it); `todo` is defined work you will do (born a ticket). The test: can you *phrase* the question precisely now? Yes → ticket, no → fog.

## Principles

- **Execution inside the map (default).** Unlike a plan-only approach ("plan, don't do"), here the map carries **construction** within it: after the decision tickets, build tickets graduate from the fog and are **executed** as children of the map. The destination is the **working** artifact (a deployed app), not a spec document; the spec is a waypoint. *Override:* a project that must stop at the spec declares it in the map's `## Notes` (that wins over this default).
- **Refer by name.** Every map and ticket is an issue, so it has a **title**. In everything the human reads, refer by name, never by a bare `#number`. A wall of `#42, #43, #44` is illegible; names read at a glance. The id and URL don't vanish (a name wraps its link) but they ride *inside* the name. **One exception: a command the user must run.** In `/trailhead:work <ticket>` the argument is machine input, not prose; give the **bare number** there (a long title, with its punctuation and jargon, is awkward and error-prone to type). Name the ticket in the surrounding sentence, put the number in the command.
- **Result-oriented output.** In the chat, report **what was done and the next step**: refer to tickets by name and give the concrete next command. Do **not** expose trailhead's internal machinery: Mode labels (`Mode 1`, …), protocol/step names (`DISCUSS`/`PLAN`/`VERIFY`, "the build engine", "Session handoff", "graduate the fog", "the frontier"), or wrapper/SKILL.md mechanics. **Nor narrate the conventions and config you are silently obeying**: the git mode (`main`/`pr`), the isolation/worktree decision, submodule commit mechanics (commit-inside + gitlink bump), claim/assignment plumbing, which model ran a step. These are housekeeping you just *do*; reciting them ("the conventions say `git: main`, no worktree isolation, submodule work commits inside + a gitlink bump, and the ticket is already assigned to you") is noise, not a status update. Just act, then report the outcome. Surface a convention only when it **changes what the user must do** (a UAT they run, a release awaiting their command, a genuine claim collision with *another* login) or when they explicitly ask. (A map may reinforce this in its `## Notes`, but it holds regardless.)
- **No em-dashes.** Write with ordinary punctuation: commas, colons, semicolons, parentheses, periods. Never use an em-dash (U+2014), and never a hyphen standing in for a comma. This holds for **everything trailhead produces**: ticket titles and bodies, engine comments, the map body, commit descriptions, chat output, and the skill's own source docs. En-dashes in numeric ranges (`1–2`) and the arrow `→` in trailhead's notation stay; only the em-dash is banned.
- **One ticket per session: hard rule.** Resolve **at most one** ticket per session; once one is resolved, do **not** start a second; end the session instead. The only exceptions: `research` tickets (AFK, run in parallel) and `capture` operations (they resolve nothing). On resolving a ticket, close the session with the **[Session handoff](#session-handoff)** ritual.
- **Git per the repo's conventions.** The default is commit straight to `main`, conventional commits, no feature branch/PR, but the repo's `trailhead:conventions` issue governs: honour its `git:` (`main` | `pr`), `release:` (`command` | `auto`), and `isolation:` (`none` | `worktree`) header. Never `Co-Authored-By`. **Every commit made while resolving a ticket carries a `Refs: #<n>` trailer** (the ticket's issue number) as its last line, so GitHub threads the commit into that ticket's timeline (the commits show up *in* the ticket). Use a **non-closing** reference (`Refs:`): never a closing keyword (`fixes`/`closes`/`resolves #n`), because the ticket is closed **explicitly at Resolve** after Verify passes, not by a commit landing on the trunk. (Charting/config commits not tied to a ticket carry no `Refs:`.)

## Session handoff

Resolving a ticket **ends the session**: one ticket per session is a hard rule (see [Principles](#principles)). So every resolution closes the same way. After the resolution comment + `gh issue close` + the `Decisions so far` update, **remove the session-ticket marker** (`.trailhead/session-ticket` at the working root, if you wrote one, see Mode 2), then **always** sign off with, in order:

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
| Map | an issue with label `trailhead:map`. **Pin it** while it's live, along with the codebase and conventions issues: GitHub's **3 pinned-issue slots** are exactly map + codebase + conventions, so the repo's trailhead anchors stay one click away (`gh api graphql` `pinIssue` mutation on each issue's node id). **When a map is exhausted** (destination reached: no open tickets and no fog left), **unpin it** (`unpinIssue` mutation) to free its slot, then **ask the user whether to close the map issue**: on a yes, `gh issue close` it (a closed issue is still the durable record); on a no, leave it open, just unpinned. Never close a map unprompted. The **codebase and conventions stay pinned permanently** (repo-scoped); the next map charted on the repo takes the freed slot. **With several live maps at once** the 3rd slot holds the active/primary one and the others stay unpinned but listed, see [Multiple maps on one repo](#multiple-maps-on-one-repo-parking--concurrency). Each map's **tickets** share a **`trailhead:map-<n>` label** (n = the map's issue number) that scopes its frontier; the map issue itself is found by its number and does not carry it. |
| Codebase | a **single per-repo** issue with label `trailhead:codebase`: the distilled codebase map (architecture, stack, conventions, decisions embodied, risks, test/build). It's repo-scoped: **shared by every map of this repo, owned by none**, so it survives when a map is finished. Each map's Notes *links* it (never re-inlines it). Not a `trailhead:ticket`, so it's off the frontier. Written at adopt; a **greenfield map** (`/trailhead:new`) has no code to map at chart, so it's created **later, once the repo has substantial code** (e.g. after the first build tickets land), via the Codebase map technique. **Kept fresh at Resolve**: when a resolved `build`/`bug` ticket **materially changes** the map (a new module or layer, a new dependency/integration, a new seam, a changed build/test command, a new convention), **patch the affected facet of this issue in place** as part of Resolve, one or two lines, not a re-run of the fan-out. Cosmetic or in-facet changes leave it alone; a full re-map is only for major drift. |
| Conventions | a **single per-repo** issue with label `trailhead:conventions`: the project's **way of working**, readable by everyone. Repo-scoped and linked from every map's Notes, like Codebase. It opens with a small machine-read header the engine obeys, then human prose. Header keys (defaults **bold**): `git:` **`main`** \| `pr` (commit straight to `main`, or feature branch + PR) · `release:` **`command`** \| `auto` (never release without an explicit command, or release automatically per the project's flow) · `isolation:` **`none`** \| `worktree` \| `clone` (work in the current checkout; or give each executing ticket its own `git worktree` + `trailhead/t<n>` branch; or a dedicated per-ticket **clone** at `../<repo>-t<n>` for **path-bound apps a worktree can't build**, e.g. React Native/Expo with a local `node_modules`; see [Working as a team](#working-as-a-team)). **`worktree`/`clone` imply a branch per ticket even under `git: main`** (git won't check the trunk out twice); the branch integrates to the trunk per `git:` at Resolve. Under **`none`** two in-progress tickets with overlapping `Scope:` **serialise** (the second holds at claim). Below the header: the standing "how we work here" notes. **Filled at chart/adopt by a brief conventions brainstorming** (see the Invocation modes), not a `trailhead:ticket`, off the frontier. |
| Ticket | a child issue with label `trailhead:ticket` + exactly one **type** label: `trailhead:decision` / `trailhead:research` / `trailhead:prototype` / `trailhead:build` / `trailhead:bug` / `trailhead:task`, plus its map's `trailhead:map-<n>` label and native sub-issue edge (see Child→map link) |
| Child→map link | three views of one fact, wired in the same pass (like a blocker): a `Parent: <map name>(link)` line in the ticket body (human-readable); a **native sub-issue** edge to the map (`gh api --method POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id=<ticket .id>`, the structure GitHub renders); and the map's **`trailhead:map-<n>` label** on the ticket (the queryable key that scopes its map's frontier). See [Multiple maps on one repo](#multiple-maps-on-one-repo-parking--concurrency). |
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
- **`trailhead:whiteboard`**: a **map-less** ticket, parked on the **whiteboard** (the container for work not tied to any map). **Mutually exclusive with a `trailhead:map-<n>` label**: a ticket is on a map or on the whiteboard, never both, and a whiteboard ticket has no `Parent:` line and no native sub-issue edge. It carries its own frontier (below), off every map's. Captured there when a capture is routed to the whiteboard, or born there by `quick`; see [The whiteboard](#the-whiteboard-map-less-tickets).

**Frontier** = open, unassigned tickets that are **not** `trailhead:blocked` and **not** `trailhead:unverified`. That's the whole query: the labels are the pre-computed answers to "are all blockers closed?" and "is this a trusted trailhead ticket?", so no per-ticket body parsing. **With more than one live map on the repo**, add the active map's `trailhead:map-<n>` label to scope the frontier to that map (still one query); with a single map the repo-wide query below is the frontier. See [Multiple maps on one repo](#multiple-maps-on-one-repo-parking--concurrency).

**Map frontier vs whiteboard frontier.** The whiteboard (tickets labelled `trailhead:whiteboard`, map-less) has its **own** frontier, queried by that label with the same open/unassigned/not-blocked/not-unverified filter, and it is **excluded from every map frontier**: the multi-map query already excludes it (whiteboard tickets carry no `trailhead:map-<n>`), and the single-map repo-wide query adds `-label:trailhead:whiteboard`. So a map's frontier and the whiteboard's never overlap. `/trailhead:whiteboard` renders the whiteboard frontier; `/trailhead:map` and bare `/trailhead:work` stay on the map. See [The whiteboard](#the-whiteboard-map-less-tickets).

**Blocked-by reconciliation (drift check).** The `## Blocked by` prose and the native dependency are two copies of one fact, so they can drift (it has happened: a body naming the split-*origin* while the native edge pointed at the sibling). When rendering `/trailhead:map` and before working a ticket, **reconcile them deterministically**: parse the issue numbers in the ticket's `## Blocked by`, read its native `blocked_by` (`gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by`), and if the two sets differ, **surface an advisory** naming both sides (the native edge is the structured reference); never auto-fix, never block. If the body has no parseable `## Blocked by`, report it **uncheckable**, never assume they agree. This is the one deterministic, false-positive-free consistency axis; higher-level "does a ticket contradict the map's decisions" drift is left to human judgement.

Base commands:
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
gh issue list --label "trailhead:ticket" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
# the whiteboard frontier: map-less loose tickets, its own query
gh issue list --label "trailhead:ticket" --label "trailhead:whiteboard" --state open --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
# unblock a ticket once its last blocker closes (label only; native edge auto-reflects)
gh issue edit <n> --remove-label "trailhead:blocked"
# claim
gh issue edit <n> --add-assignee @me
# resolve
gh issue comment <n> --body-file <resolution>   &&   gh issue close <n>
```
**First-use repo setup (do BOTH, every chart or adopt, never skip either):**
1. Create any missing labels with `gh label create` (all seventeen: `trailhead:map`, `trailhead:codebase`, `trailhead:conventions`, `trailhead:ticket`, the six type labels, `trailhead:blocked`, `trailhead:seed`, `trailhead:out-of-scope`, `trailhead:superseded`, `trailhead:unverified`, `trailhead:fog`, `trailhead:whiteboard`).
2. **Check the label guard is installed**: `gh api repos/{owner}/{repo}/contents/.github/workflows/trailhead-label-guard.yml`; if it's absent (404), install it: **read `references/teamwork.md` (Trust & provenance → Repo-side enforcement) for the exact steps**. This is part of standing up trailhead in a repo, not an optional extra: *check every time*, so a repo can never end up with the labels but no guard.

## The Map

A single `trailhead:map` issue, the canonical artifact. It's an **index**, not a store: it lists the decisions made and points at the tickets that hold their detail. A decision lives in exactly one place (its ticket); the map gists it and links.

**`/trailhead:map`** renders this at low resolution as a read-only dashboard (it changes nothing on its own; see the exhaustion check below), the map body plus the live ticket state, by name:
- **Destination**: the one-line where-we're-headed.
- **Frontier**: takeable now (open, unassigned, not blocked/unverified), each with its type.
- **In progress**: claimed tickets, with who holds each.
- **Blocked**: with what each waits on; flag any **blocked-by drift** (prose `## Blocked by` ≠ native dependency, see [Blocked-by reconciliation](#substrate-github-issues)) as an advisory line.
- **Decisions so far**: the index of what's settled.
- **Not yet specified** + **parked fog**: the coarse fog, and a count/link of open `trailhead:fog` issues.
- **Out of scope**: what's been ruled out; **flag as an advisory** any line that's actually **deferred** rather than truly beyond the destination: it **names a gate/trigger** (*gated by X*, *quando X*, *dipende da X*), carries a **this-only qualifier** (*per questo slice*, *for now*, *in this milestone*), is a **feature wanted later** (another milestone/map), or **is the gate of an existing `trailhead:seed`** (a seed's trigger names it, so it cannot be "ruled out", and that cluster is mis-wired). **Flag only lines not yet properly parked**: a line **already annotated `→ future map`** whose dependent seeds are **wired to a live trigger** is settled, say nothing about it. When one or more **un-parked** such lines are present, **don't stay silent: name them and suggest `/trailhead:inbox` to re-route them** (seed/idea/todo). See [Out of scope](#out-of-scope).
- **Inbox**: a count of untriaged inbound issues, as a nudge.
- **Exhaustion check**: if the map is exhausted (no open tickets and no fog left: the destination is reached), **say so and ask whether to close the map issue**, the same ask as Mode 2's hand-off: on a yes, unpin it and `gh issue close`; on a no, leave it open (just unpinned). Never close unprompted. Route any un-parked deferred *Out of scope* line first (above) so nothing wanted-later is lost. This user-confirmed close is the only state `/trailhead:map` ever changes, and only on an explicit yes.

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

Load the effective config at the start of a work session, **from the map's project root** (`.trailhead/config.json` at the superproject repo root) plus the global file, **before** any isolation workspace is set up. **Config is a property of the project/map, not the working directory**: an `isolation: worktree`/`clone` workspace **inherits** the config loaded here and must **never re-resolve it from the isolated copy's own root**, because a per-ticket clone (a submodule clone especially) has no `.trailhead/` of its own and would silently fall back to defaults (this is exactly how a `design: claude.ai/design` project ends up wrongly using `disk` in a clone). Config **writes** too (e.g. caching `design.project`) target the project's `.trailhead/config.json` in the original checkout, never the clone. **The main session orchestrates and holds the HITL moments** (the `build`/`bug` Discuss's "stop and ask", Verify's acceptance/UAT); **every model key runs as a subagent** (`plan`, `execute` (an *executor subagent* implementing with atomic commits on `models.execute`), `research`, `review`, `debug`) so the whole per-activity model split applies in one session whatever model it runs on. Run Execute inline only when `models.execute` is unset or equals the session model. The **keys, their values, the model/tdd/acceptance semantics, and the guided menu setup live in `references/configuration.md`**: read it when running `/trailhead:config` or when you need a key's exact meaning. `/trailhead:config` with no args runs the guided setup; `config get` prints the merged config; `config set <key> <value>` writes one key.

**Ticket language (standing engine rule).** Write **all human-authored trailhead prose on the Issues** (ticket titles and bodies, every engine comment (`DISCUSS`/`PLAN`/`VERIFY`/`OPTIONS`/`REPRO`/`DIAGNOSIS`/`PAUSED`/resolution), and the map body sections) **and commit message descriptions** in `config.ticket.language` (ISO 639-1, default `en`). The conventional-commit **type prefix stays English** (`feat:`/`fix:`/…). This is **independent of the language the agent converses in** and never changes it; likewise it never touches code, identifiers, the fixed `trailhead:*` label names, or config keys/values. The skill's own source docs stay English regardless.

**This is the single most-missed rule, and the trap is specific: when you are chatting in one language and go to write a ticket, the body reflexively comes out in the *chat's* language, which is wrong.** The chat language and the ticket language are decoupled on purpose. Before every `gh issue create`/`edit`/`comment` and every commit body, consciously write in `config.ticket.language` (default `en`), not the language of the conversation. This holds for the zero-friction captures too (`bug`/`todo`/`idea`/`seed`/`note`): a one-line Italian request still becomes an English ticket. If you catch a ticket, comment, or map section already written in the wrong language, **convert it in place before continuing** any other work.

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

The ticket engines call these by name. Each technique's full protocol lives in its own file under `references/techniques/`: **read that file the first time a session needs the technique**, so only the ones in play load into context (don't preload them). They are `trailhead`'s own, self-contained; subagents are spawned with the built-in `Agent` tool.

**Pin the subagent type; never borrow a foreign agent.** Every technique subagent carries its full protocol in the prompt (from its `references/techniques/` file), so it needs no specialised agent, and must not use one: **always set `subagent_type` to a built-in agent, never a project- or plugin-provided type** (a specialised `*-reviewer`, `*-researcher`, `*-mapper`, or similarly named agent that another installed tool registered). Even when such an agent's name or description matches the task perfectly, it follows *its own* protocol and artifact conventions (a specialised code-review agent writes its own review file, not trailhead's `VERIFY` ticket comment), so selecting it silently swaps trailhead's engine for another tool's. The split by what the technique touches: **read-only techniques** (Code review, Codebase map, and the Plan step) spawn **`Explore`** (reads, searches, runs tests; no Edit/Write); **repo-modifying techniques** (Research, Execute, Fix, Debug) spawn **`general-purpose`**. On a `subagentToolkit == none` host (Codex) there is no fan-out and this is moot: every technique runs inline in the one session.

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
2. **Plan**: a `PLAN` comment: the steps, the seams, the files touched, the verification criteria. Apply **TDD** per `config.tdd` (`seams`/`on`/`off`). Produce this plan via a *planner subagent* on `config.models.plan` (spawn it as the built-in **`Explore`** agent, read-only; inline when the model is unset or equals the session model; Execute then runs as its own subagent, see below). If `config.plan_review` is on, run **Cross-AI plan review** before Execute: send the plan to external AI CLIs and converge on their concerns. Now that the files/seam are known, run the [undeclared-coupling check](#working-as-a-team) against in-progress tickets.
3. **Execute**: **if this ticket changes user-facing UI (a new screen, a redesign, a changed layout), run the [Prototype](#techniques) technique FIRST, before any real UI code**: surface a mockup to react to, routed by `config.design` (disk / claude.ai/design) and gated by `config.design.approval` (`explicit` waits for a go-ahead, `auto` proceeds after surfacing). For a redesign or new screen the default is to offer mockups; don't jump straight to code on a UI ticket. Then implement with **atomic commits** (conventional commits, each with a `Refs: #<n>` trailer for this ticket, see [Principles](#principles)), following the repo's `trailhead:conventions` `git:`, straight to `main` by default, or a feature branch + PR when `git: pr`. **Under `isolation: worktree`, do the work in this ticket's `git worktree`** (`trailhead/t<n>` branch), integrating to the trunk at Resolve (see [Working as a team](#working-as-a-team)). One commit = one verifiable step. Run this via an **executor subagent on `config.models.execute`** (spawn it as the built-in **`general-purpose`** agent, which can Edit/Write/commit; inline when the model is unset or equals the session model); the commits land on `main`, visible. New scope surfacing mid-execute is captured/split, not worked here.
4. **Verify**: a `VERIFY` comment: run the tests / the plan's criterion; then the **Code review** technique (its subagent reviews *adversarially*: it doesn't defer to a `CLAUDE.md` convention or a "settled decision" memory); then **Acceptance testing** if the change is user-facing (browser-drive it, or **walk the user through a guided UAT conversationally, one step at a time**, never a checklist dumped in a comment). Report the outcome honestly (if a test fails, say so).
5. **Resolve**: a resolution comment with what was done → `gh issue close` → update `Decisions so far` on the map. **If this change materially altered the codebase** (a new module/layer, dependency, seam, or build/test command), **patch the affected facet of the [`trailhead:codebase`](#substrate-github-issues) issue** in place (a line or two, not a re-map). Then close the session with the **[Session handoff](#session-handoff)** ritual (`/clear` + next command).

New scope that surfaces mid-build (while planning, executing, or testing) → **capture or split, never expand this ticket in flight** (see [Scope that surfaces while working a ticket](#capture-zero-friction--tracker)).

### `bug`: the fix with diagnosis first
A defect to correct. Unlike `build`, you don't start from implementation: first you **understand**.

**New bug ticket vs reopen: decide first.** A bug in the work of an already-closed ticket almost always means a **new** `bug` ticket, *not* reopening the old one, because `Decisions so far` is append-only history: that ticket really did deliver, and the defect surfaced later is a new event. The one exception is a **premature close**: a ticket closed before its Verify ever passed, i.e. it never actually delivered. The discriminator is sharp: **did that ticket genuinely pass Verify?**
- **Yes** → new bug ticket carrying `Regression of: <closed ticket name+link>` in its body. Leave the original closed. Open it with `/trailhead:bug --of <ticket> <text>` (below), which fills the pointer for you.
- **No** (closed by mistake, never delivered) → this isn't a new bug, it's a bad close: `gh issue reopen <n>` and finish it.

Then run the cycle, all in ticket comments:

1. **Repro**: a `REPRO` comment: how to reproduce, expected vs observed behaviour.
2. **Diagnose**: run the **Debug** technique. A `DIAGNOSIS` comment with the root cause.
3. **Fix**: implement the correction with **atomic commits** (each with a `Refs: #<n>` trailer for this ticket, see [Principles](#principles); per the repo's `trailhead:conventions` `git:`, `main` by default, else a branch + PR; in this ticket's `git worktree` under `isolation: worktree`), via an **executor subagent on `config.models.execute`** (the built-in **`general-purpose`** agent; inline when unset/same as session). Where sensible, a test that fails before and passes after (**TDD**).
4. **Verify**: a `VERIFY` comment: the repro now passes, no regressions; **Code review** on the fix; **Acceptance testing** if the bug was user-facing (browser-drive the fixed flow, or **walk the user through a guided UAT conversationally, step by step**, not a checklist to self-serve).
5. **Resolve**: a resolution comment (cause + fix) → `gh issue close` → update `Decisions so far`. **If the fix materially altered the codebase**, patch the affected facet of the [`trailhead:codebase`](#substrate-github-issues) issue in place (a line or two). Then close the session with the **[Session handoff](#session-handoff)** ritual (`/clear` + next command).

A **blocking** bug that halts other work is worked immediately; an isolated one is a normal frontier ticket. New scope surfacing while fixing → capture or split, never expand this ticket in flight (see [Scope that surfaces while working a ticket](#capture-zero-friction--tracker)).

### `task`: HITL or AFK
Manual work that must happen before a *decision* can be made: signing up for a service to judge its API, provisioning access, moving data to see its shape. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and the resulting facts (where credentials live, new URLs, row counts) later tickets depend on.

### `quick`: work one ticket whole, off the map
A streamlined way to just get one ticket done, without map ceremony. `quick "<text>"` opens a **whiteboard** ticket (a `build`, or a `bug` when the text is clearly a defect) and works it end to end now; `quick <n>` works an **existing** ticket (whiteboard or map) the same way. Claim it first; still one ticket per session.

It runs the **full engine** (the `build`/`bug` cycle: Discuss → Plan → Execute → Verify → Resolve), differing from `work` on three points:
- **Grill only if needed** (Discuss): never auto-grill; start from Plan and stop to ask only if a blocking ambiguity surfaces, exactly as the `build` Discuss. The user may ask to grill at any time.
- **Never splits.** If the ticket turns out large, work it whole anyway: that is the point of `quick`. Do not `split` it and do not spin children. (New scope that surfaces mid-work is still captured out, never folded in, see [Scope that surfaces while working a ticket](#capture-zero-friction--tracker).)
- **No map book-keeping.** A whiteboard ticket has no map, so there is no `Decisions so far` update, no fog to graduate, no frontier re-scan. Everything else holds: atomic commits with `Refs: #<n>`, TDD / Code review / Acceptance testing per the cycle, the resolution comment + `gh issue close`, and the [Session handoff](#session-handoff). For `quick <n>` on a **map** ticket it still skips the split and the map book-keeping (that is what `quick` means); use `work <n>` when you want the normal map flow.

Type follows the ticket: `quick "<text>"` defaults to `build` (`bug` if a defect); `quick <n>` uses the existing type and its matching engine.

## Fog of war

The map is *deliberately* incomplete: don't chart what you can't yet see. Beyond the live tickets lies the fog: decisions and investigations you can feel coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating into fresh tickets whatever has become specifiable, one at a time, until the way to the destination is clear and no tickets remain.

**Not yet specified** is where that dim view is written: the suspected question, the area to revisit. Everything here is in scope, just not sharp enough for a ticket.

**Fog or ticket?** The test is whether you can *phrase* the question precisely now, not whether you can *answer* it now.
- **Ticket** when the question is already sharp, even if blocked.
- **Not yet specified** when you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces.

## Out of scope

Fog only ever gathers *toward* the destination. Work beyond the destination is **out of scope**: it isn't fog, it doesn't belong in *Not yet specified*. It gets its own section on the map. It never graduates: the frontier stops at the destination. When an existing ticket turns out to sit beyond the destination, label it **`trailhead:out-of-scope`**, **close it**, and leave one line in *Out of scope* with the why, linking the closed ticket. The label keeps it distinct from a resolved ticket; it stays out of *Decisions so far*, which records the way actually walked.

**Out of scope vs deferred (ask, never bury).** *Out of scope* is for work ruled beyond the destination **for good**: this effort never does it. It is **not** a parking lot for work that *will* happen but hangs on something **outside this map**, a feature, function, or milestone not ticketed here (e.g. a billing / *bolletta* module that lives elsewhere or comes later, and the items that wait on it). Before filing anything under *Out of scope*, apply the test: **will this actually get done once X exists?** **The tells of a deferred line (any one is enough):** it **names a gate or trigger** (*gated by X*, *quando X*, *once X exists*, *dipende da X / waits on X*); it carries a **this-only scope qualifier** that rules it out *here* but not for good (*per questo slice*, *for now*, *in this milestone*, *not in this map*), which means wanted-later, not rejected; it's a **feature the product will plausibly still want** (a later milestone, another map); or **an existing `trailhead:seed` is gated on it** (some seed's trigger / `## Blocked by` names this line), which makes it a **live gate by definition**. Any one of these is deferred: never wave it through as "genuinely beyond the destination". Only work **decided against for the product** (won't ever be built, wrong approach, explicitly cut, with **no** "for this slice / for now" qualifier) is truly out of scope. **A line that is the gate of a live seed can never be "ruled out"**: finding one means the cluster is mis-wired (the gate was left behind when its dependents became seeds), so re-route the gate too (see below), or those seeds' triggers dangle. If yes, it isn't out of scope, it's **deferred**, so don't close-and-forget it. **Ask the user how to capture it, and which map it belongs to** (this map, or a future / other map); **never decide silently, and every move out of *Out of scope* is user-confirmed** (you propose, the user picks the tier and the map). Route along the [capture spectrum](#capture-zero-friction--tracker): a **`seed`** gated on its trigger (tie it to what it waits on, e.g. *when the bolletta exists*), an **`idea`** to revisit, or a **`todo`** if it's already defined work to do now. **If it belongs to a future map** (defined work wanted for the product, but beyond this effort's arc), don't fabricate a map that isn't charted yet, but **do capture it as a real artifact, asking the user which**: a **`seed`** (a gated todo, a tracked issue that survives the map, is queryable by label, and can be the native `blocked_by` of its dependents) or an **`idea`** (a fog line, lighter, for a maybe-later). **Never leave it as a bare *Out of scope* text line**: that's the fragile case (a finished map's *Out of scope* is easy to lose, and a dependent wired to a text line has no real target). Leave only a one-line *Out of scope* **breadcrumb pointing at the artifact** (`→ future map: <name>, see <seed/idea link>`). It then **graduates into the current map** the moment this effort actually needs it (it "comes up on its own"), or **the next map charted on this repo harvests it**, its chart step asking which parked seeds/todos/ideas to pull in (see [Mode 1](#mode-1-chart-the-map-new-project-trailheadnew) / [Mode 1-bis](#mode-1-bis-adopt-an-existing-project-trailheadadopt)). Whichever way, **the gate and its dependents move together** (a dependent seed's trigger points at the gate's artifact, a live target), never split across "ruled out" and re-routed. **Re-route the gate, not just its dependents.** When the thing a deferred item waits on (its gate X) is itself an *Out of scope* / deferred line, X is deferred by the same test: **re-route X first** (its own `seed`/`idea`/`todo`, or a named future-milestone / another-map pointer), then **tie the dependents to X's new form**, never to a line that stays in *Out of scope*. A seed's trigger must point at a **live** target: a ticket/seed here, a named milestone/map, or a real external condition; a seed gated on a dead "ruled out" line has a trigger that can never fire. **Move a gate and its dependents together**, so the whole cluster leaves *Out of scope* at once (e.g. the *bolletta* becomes its own seed, and the "gated by the bolletta" items become seeds wired to it, none left behind as "ruled out").

Only genuinely-beyond-the-destination work stays in *Out of scope*. The same test applies to **stale *Out of scope* lines** noticed later: `/trailhead:map` (read-only) **flags** any **un-parked** deferred line as an advisory (like blocked-by drift, it changes nothing) **and suggests running `/trailhead:inbox` to re-route them**, while `inbox` or an explicit user go-ahead does the **actual re-route**, a line that's really deferred becoming a seed/idea/todo instead of lingering as "ruled out". A line **already parked** (annotated `→ future map` with its dependent seeds wired to a live trigger) is settled: neither surface flags it again.

## Capture (zero friction → tracker)

Capture without breaking flow, to the **tracker** (not scattered files). One capture = one action + one confirmation line; it **resolves nothing**. The verbs are in the **Capture** table under [Commands](#commands); their per-verb detail and the **note · idea · seed · todo** commitment/timing spectrum (raw text → fog → gated ticket → frontier ticket) are in **`references/capture.md`**: read it when a capture verb needs more than the one-line gist. Any captured **ticket** lands either on a **map** or on the **whiteboard** (map-less): **when a map is open, ask the user which** before creating it (active map vs whiteboard; if several maps are open, the same ask picks which map). On a map it gets that map's `trailhead:map-<n>` label + native sub-issue edge (like any ticket; see [Multiple maps on one repo](#multiple-maps-on-one-repo-parking--concurrency)); on the whiteboard it gets the `trailhead:whiteboard` label and **no** map label or `Parent:` (see [The whiteboard](#the-whiteboard-map-less-tickets)). **When no map is open at all, the ticket goes to the whiteboard without asking** (there is nowhere else). This ask applies to the ticket-producing captures (`todo`, `bug`, `seed`, and `idea` only when it is sharp enough to be a ticket); `note` and a non-sharp `idea` stay map-fog and are unaffected.

**Scope that surfaces while working a ticket.** Testing or building X often sparks new ideas: do **not** grow X in flight; a ticket is one answerable Question, sized to one session. Decide per idea:
- part of X's Question and small → just do it in X (that's completing X, not expanding it);
- it balloons X past one session → **`split`** X (children carry the new pieces, supersede the original);
- separate work or a follow-up beyond X's goal → **capture and continue** (`idea`/`todo`/`ticket`/`bug --of X`), don't derail.

Tickets born this way carry a **`Surfaced from: <ticket name+link>`** line in their body (the same lineage convention as `Split from:` and `Regression of:`) so where an idea came from stays visible. Never let extras become silent lines inside X: the map stays honest by spinning them into their own tickets or fog.

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

**Pinning with several maps.** Codebase + conventions stay pinned always; the **3rd slot goes to the active/primary map**; other live maps stay **unpinned but listed** (the `trailhead:map` query above). You can't pin them all (3 slots); the label + the list keep them reachable.

**Team.** A teammate charts a new map → it gets its own `trailhead:map-<m>` + sub-issue parentage → their sessions scope to it. The two frontiers **never mix** (distinct labels). Per-ticket **claim/collision** rules are unchanged (the assignee is still the claim). Two maps can still touch the **same code**: the `Scope:` line + `isolation:` serialisation from [Working as a team](#working-as-a-team) now apply **across maps too**, not just within one.

**One-map compatibility.** With a single open map the frontier stays **repo-wide** (minus `trailhead:whiteboard` tickets, which carry their own frontier, see [The whiteboard](#the-whiteboard-map-less-tickets)); the map label + sub-issue are still applied at chart, so concurrency is ready the moment a second map appears. An older map charted before this (tickets lacking the label) needs a one-time **backfill** (add `trailhead:map-<n>` to its open tickets, set their sub-issue parent) only if you add a second map on that repo.

## The whiteboard (map-less tickets)

Not all work belongs to a map. A **bug**, a **todo**, or a one-off **task** may be about something else entirely, or simply not worth charting a map for. The **whiteboard** is where that loose work lives: tickets labelled **`trailhead:whiteboard`**, map-less (no `trailhead:map-<n>` label, no `Parent:` line, no native sub-issue edge). A ticket is on a map **or** on the whiteboard, never both.

**Ensure the label exists before applying it.** A repo that adopted trailhead before the whiteboard existed never created `trailhead:whiteboard` (first-use setup ran the old label set), so applying it would fail. Every path that puts a ticket on the whiteboard (a whiteboard-routed [capture](#capture-zero-friction--tracker), or [`quick`](#quick-work-one-ticket-whole-off-the-map) creating one) must first create the label if missing, idempotently: `gh label create trailhead:whiteboard --color C5DEF5 --description "Map-less ticket: lives on the whiteboard" 2>/dev/null || true`. This is the same ensure the first-use label step does, just reachable outside chart/adopt.

Work reaches the whiteboard two ways: a **capture routed there** (a ticket-producing `todo`/`bug`/`seed`/sharp-`idea` sent to the whiteboard instead of a map, see [Capture](#capture-zero-friction--tracker)), or a ticket **born there** by [`quick "<text>"`](#quick-work-one-ticket-whole-off-the-map).

It has its **own frontier**, off every map's (see [Substrate](#substrate-github-issues), Map frontier vs whiteboard frontier):
```bash
gh issue list --label "trailhead:ticket" --label "trailhead:whiteboard" --state open \
  --search "no:assignee -label:trailhead:blocked -label:trailhead:unverified"
```

**`/trailhead:whiteboard`** renders this as a read-only dashboard, a mirror of [`/trailhead:map`](#the-map) minus destination, decisions, and fog (the whiteboard has no direction, only loose work), by name:
- **Frontier**: takeable now (open, unassigned, not blocked/unverified whiteboard tickets), each with its type.
- **In progress**: claimed whiteboard tickets, with who holds each.
- **Blocked**: any blocked whiteboard ticket, with what it waits on (a whiteboard ticket can still block on another).

**Working the whiteboard.** Take a ticket with [`quick <n>`](#quick-work-one-ticket-whole-off-the-map), or `work <n>` by number; both work a single whiteboard ticket. There is no book-keeping to fold back (no `Decisions so far`, no fog to graduate), so a whiteboard resolution is just the resolution comment, `gh issue close`, and the [Session handoff](#session-handoff). Whiteboard tickets are never pinned and take no map slot.

## Working as a team

Many people (and their sessions) share one map concurrently; the tracker is the single source of truth. **Claiming (needed every time you work a ticket):** assign it to yourself before any work (`gh issue edit <n> --add-assignee @me`), re-read the assignee right before starting, and on a **collision stop and ask the user**: never resolve it silently; unclaim if you stop; never touch a ticket someone else holds. Whoever claims a ticket owns it end to end and closes it (no approver).

The rest of the concurrency protocol lives in **`references/teamwork.md`**. Read it when you do that thing: **pausing & resuming** (`PAUSED` checkpoints, release vs keep the claim), **parking & switching between concurrent maps** on one repo (see also [Multiple maps on one repo](#multiple-maps-on-one-repo-parking--concurrency)), **splitting** an oversized ticket (children + supersede + re-point blockers), the **undeclared-coupling** check between parallel tickets, safe **concurrent map-body edits**, and **trust & provenance** (the trust rule, the `trailhead:unverified` quarantine, and installing the repo-side **label guard** at first-use).

## Inbox: issues opened by others

`/trailhead:inbox [issue]` triages issues opened by others (bug reports, requests, questions that aren't trailhead tickets) and integrates the worthwhile ones **in place**: reframing them as tickets, keeping the reporter's authorship, applying the labels on adoption; the rest routes to fog, out-of-scope, duplicate, or needs-info. It also surfaces **parked `trailhead:fog`** whose thread went quiet-then-active (that's how you notice a fog has cleared), **and sweeps the map's own *Out of scope* for lines that are actually [deferred](#out-of-scope)** (a gate/trigger or a wanted-later feature), asking the user to re-route each to a seed/idea/todo (which map) and wiring it gate-first with a live trigger. This is the surface where the map's read-only advisory turns into an actual re-route. **Full protocol (the three sections, the adopt/fog/out-of-scope/duplicate/needs-info routing, the deferred-out-of-scope sweep, the `trailhead:unverified` handling) in `references/inbox.md`**: read it when running inbox.

## Invocation

### Mode 1: Chart the map (new project), `/trailhead:new`
The user invokes with a loose idea.

1. **Name the destination.** Run the **Grilling** + **Domain vocabulary** techniques to pin down what this map tends toward. The destination fixes the scope, so it's settled first. Default: a working artifact.
2. **Map the frontier.** Grill again, **breadth-first**: fan out across the whole space rather than deep on one thread, surfacing the open decisions and the first steps takeable now. **If no fog surfaces** (the way is already clear, the whole thing fits one session) you don't need a map: stop and ask how to proceed. **Harvest parked work:** from **earlier maps on this repo**, gather the artifacts their *Out of scope* `→ future map` breadcrumbs point at (**parked seeds/todos**, see [Out of scope](#out-of-scope)) **and the ideas** left in their *Not yet specified* fog, then **ask the user which belong in *this* map**; pull the chosen seeds/todos in as tickets and the chosen ideas in as fog (or as tickets, if now sharp enough), and leave (or update the destination on) the rest.
3. **Create the map** (`trailhead:map`): Destination and Notes filled in, Decisions-so-far empty, the fog sketched into *Not yet specified*. Run the [first-use repo setup](#substrate-github-issues) now: labels **and** the label-guard check/install. Once the map issue has its number `<n>`, **create its per-map label `trailhead:map-<n>`** (every ticket of this map carries it and is a native sub-issue of the map; the map issue itself is found by its number, so it does **not** carry the label; see [Multiple maps on one repo](#multiple-maps-on-one-repo-parking--concurrency)). **If this repo already has another open `trailhead:map`**, tell the user the new map runs concurrently (its own scoped frontier) and set it as the active map (`.trailhead/active-map`). Then set up **conventions**: if no `trailhead:conventions` issue exists, run a **brief conventions brainstorming** (breadth-first, in the spirit of grilling but short: a handful of questions, not a full session) to surface the project's way of working: `git:` `main`|`pr`, `release:` `command`|`auto`, and `isolation:` `none`|`worktree` (the header, the last asked as *"will more than one session run on a single clone at once?"* → `worktree`; a monorepo leans `worktree`), **plus** the narrative a new contributor would need: release/deploy specifics (environments, manual steps, OTA vs full build, versioning), tooling that must be driven a certain way (a specific MCP/CLI, e.g. a Lovable project piloted via its MCP), code & style rules, testing/UAT norms. Distil into the issue (header + prose); link it from the map's Notes. Don't invent: leave out or ask what you can't determine. If one already exists, just link it (reuse across maps).
4. **Create the tickets you can specify now** as child issues (each with `trailhead:ticket` + its type + this map's `trailhead:map-<n>` label, and set as a **native sub-issue** of the map, see [Child→map link](#substrate-github-issues)), then wire the blocking in a **second pass** (issues need ids before they can reference each other): for each ticket **read its Question and wire a blocker for every still-open ticket whose output it consumes** (don't stop at the first/obvious one), then run the three-move wiring (`## Blocked by` line + native dependency + `trailhead:blocked` label, see [Substrate](#substrate-github-issues)). Wiring sorts them into frontier (unblocked) and blocked; the rest stays fog.
5. **Fire the research subagents.** For each `research` ticket created, run the **Research** technique in parallel, findings on a `research/<name>` branch with a pointer from the ticket.
6. **Offer config, then stop.** Charting is one session's work; it hand-resolves nothing. Before ending, make the **first-time config offer** (see [smart entry](#commands)): the project now has a fresh map and no `.trailhead/config.json`, so put the **two-way choice** to the user, **accept as-is** (writes `{}`) or **run `/trailhead:config`** for the guided menu, and let them pick. Name both paths; don't pre-fill the config keys and ask for an inline edit, and don't interview them key-by-key here (that's `/trailhead:config`'s job). Once the file exists it's never offered again. **No `trailhead:codebase` issue is created here**: greenfield has no code to map yet. It's created later, once the repo has substantial code (see Mode 2 step 1 and the [Codebase](#substrate-github-issues) row), so at chart only two of the three pin slots (map + conventions) are filled.

### Mode 1-bis: Adopt an existing project, `/trailhead:adopt`
When the code already exists (project in progress). Like Mode 1, but start from **reality**, not a blank page. One heavy step at entry, then all lean.

1. **Map the codebase (once per repo).** Heavy step, *only* at adoption: it does not repeat per ticket, and **not per map**. First check for an existing **`trailhead:codebase`** issue: if one exists (an earlier map on this repo created it) and the code hasn't materially drifted, just **link it** from this map's Notes and skip the fan-out. Otherwise run the **Codebase map** technique (a parallel fan-out of reader subagents) for a structured understanding (architecture, stack, decisions already embodied, risk areas) and distil the essence into the repo's **`trailhead:codebase` issue** (create it, label `trailhead:codebase`), then link that issue from the map's Notes. Discard the raw. Because it's a standalone repo-scoped issue, the next map reuses it instead of re-deriving or losing it.
2. **Name the destination of the remaining stretch.** **Grilling** + **Domain vocabulary**, **seeded by the map you just built**: not "what is the project" but "what's left to reach working / the next milestone".
3. **Backfill the decisions already made.** Choices already embodied in the code (now visible from the map) or stated by the user go into `Decisions so far` as **ticket-less** lines (they're already closed), so the map reflects reality and doesn't pretend greenfield. Link to code/commits where useful.
4. **Map the frontier of the remainder** → tickets specifiable now + fog in *Not yet specified*, then wire the blocking and fire the research. **Harvest parked work** (todos *and* ideas) from earlier maps on this repo (their `→ future map` *Out of scope* lines and their *Not yet specified* fog), asking the user which belong here, as in Mode 1 step 2. As Mode 1, steps 4–6.

The tracker is the existing repo's (`gh` in its directory); run the [first-use repo setup](#substrate-github-issues) on first use (missing `trailhead:*` labels **and** the label-guard check/install (adopting an existing repo is exactly when the guard tends to be missing)) and set up the `trailhead:conventions` issue via a **brief conventions brainstorming** (see Mode 1 step 3), but here, **seed the questions from what's discoverable** so you confirm rather than ask blind: an existing `CLAUDE.md`/`AGENTS.md`, CI workflows, the PR-vs-`main` git history, package scripts, deploy config. **Detect a monorepo** (a `pnpm-workspace.yaml`, a `workspaces` field, an `nx.json`/`turbo.json`, or several packages under `packages/`|`apps/`) and, if found, propose `isolation: worktree` and note that tickets should carry a `Scope:` line, **unless the buildable units are path-bound** (see below). **Detect git submodules** (a `.gitmodules` file) and, if found, add the prose rule that submodule work is committed **inside the submodule + a gitlink bump in the parent**, isolated at the submodule (not the superproject); a submodule path is a natural `Scope:` (see [Working as a team](#working-as-a-team)). **Before proposing `worktree`, check for path-bound tooling** (a React Native/Expo app, native toolchains, a package whose build depends on a local `node_modules`/bundler cache/absolute-path config): those don't build from a worktree, so for them propose **`isolation: clone`** (a per-ticket clone that installs its own deps and builds), or `isolation: none` + **serialize** if the user doesn't want per-ticket clones. Worktree is for units that build from any path. Propose the values you inferred and let the human correct/complete them; create the issue if absent, link it from the map's Notes.

### Mode 2: Work the map, `/trailhead:work`
The user invokes with a map (URL or number). A ticket is optional: without one, you pick the next decision.

1. Load the **map** (the low-res view, not every ticket body). **Pick which map** if the repo has several open: use the one the user named, else the active map (`.trailhead/active-map`); if neither and more than one is open, list them and ask. Set/refresh the active-map marker to the one you're working. See [Multiple maps on one repo](#multiple-maps-on-one-repo-parking--concurrency). **Codebase issue check (greenfield, offer once):** if the repo has **no `trailhead:codebase` issue** (a greenfield map never got one) and now holds **substantial code**, offer once to generate it via the [Codebase map](#techniques) technique, then pin it (3rd slot) and link it from the map's Notes; if the user declines, don't nag again this session. A repo that already has the issue, or is still too thin to map, skips this.
2. Choose the ticket. If the user names one, use it (a **named** ticket may be a `trailhead:whiteboard` one: `work <n>` works it whole, off the map, with the normal cycle and split allowed; use [`quick <n>`](#quick-work-one-ticket-whole-off-the-map) for the no-split variant). Otherwise the first frontier ticket in order, **scoped to this map** (add its `trailhead:map-<n>` label to the frontier query when several maps are live) and **never a whiteboard ticket** (bare `work` stays on the map; the whiteboard frontier is reached via `/trailhead:whiteboard` and `quick`). **Claim** it: assign it to yourself before any work, then re-read the assignee before starting; on a collision, stop and ask the user (see [Working as a team](#working-as-a-team)). If the ticket proves too big once you're in it, **split** it rather than grind (same section).
   - **First, if the conventions header has NO `isolation:` key at all** (never chosen, so silently defaulting to `none`), sanity-check it **once** before working: if there's a real collision risk, don't just work the shared checkout. The risk signals are **another in-progress ticket** (a concurrent session is plausible) or **path-bound tooling in this ticket's `Scope:`** (a React Native/Expo app, native toolchain, a local `node_modules`). On a signal, surface a one-line suggestion naming it and the fitting mode (`worktree` for builds that run from any path, `clone` for path-bound apps) and offer to set it now. Whatever the user picks (**including "keep `none`"**), **write the `isolation:` key into the conventions issue** so the choice is recorded and this never prompts again. If the key is already present (any value, `none` included), it was chosen: respect it and skip this check. This is the one convention worth surfacing (it changes where you work); don't nag beyond writing the key once.
   - **Under `isolation: none`, check the scope is free before starting** (this is how a submodule/package gets serialised when worktrees don't fit): scan the other in-progress tickets' `Scope:` lines, and if one **overlaps** this ticket's scope, **stop and tell the user** the scope is busy (name the ticket + holder) and offer a disjoint-scope frontier ticket or to wait. See [Working as a team](#working-as-a-team).
   - **Write the session-ticket marker** (a cheap hint for tooling like a statusline): at the **working root** (the checkout, worktree, or clone you'll edit in), write `.trailhead/session-ticket` as **one line** `#<n> <ticket title>`. **Keep it gitignored** (add `.trailhead/session-ticket` to that repo's `.gitignore` if absent): it's per-session local state, **never committed**. It just lets an external tool show "what am I on" offline; the tracker stays the source of truth. Remove it at Resolve/handoff (see [Session handoff](#session-handoff)); on **Pause** it may stay (you'll return) or be cleared if you release the claim. The **`.trailhead/active-map`** marker (which map this session works) follows the same rules: gitignored, per-session, never committed; see [Multiple maps on one repo](#multiple-maps-on-one-repo-parking--concurrency).
   - **Under `isolation: worktree` or `clone`, set up the isolated workspace NOW, before any file edit or diagnostic probe** (not later at Execute/Fix): for `worktree`, create/enter this ticket's `git worktree` on a `trailhead/t<n>` branch for the repo the ticket's `Scope:` points at (**the submodule itself for submodule-scoped work**, e.g. `git -C app worktree add ../<repo>-t<n> -b trailhead/t<n>`); for `clone`, make an independent working copy at `../<repo>-t<n>` (branch `trailhead/t<n>`) by whichever is faster: `git clone` + the install step, or a **folder copy that brings `node_modules`** to skip the reinstall (then verify the copy's git is independent, `git -C <copy> rev-parse --absolute-git-dir` resolves inside it, else commits leak back to the original). **Because `clone` is heavy (a full clone + an install), gate it, every time, before cloning: ask the user whether they expect to work more than one ticket at once on this machine this session.** If **no**, **skip the clone** and work this ticket in the current checkout (isolation only exists to stop concurrent workspaces from colliding; a lone ticket has nothing to collide with, so the shared-checkout caveats apply and that is fine, and `git:` still decides the branch as usual); if **yes**, clone as above. The gate is **`clone`-only**: `worktree` is cheap, so set it up without asking. Do every subsequent step in whatever workspace you ended up in. This is the whole point of isolation: if you diagnose and edit in the shared checkout "just to start" while a concurrent workspace exists, you are already colliding. Set the workspace up silently (the `clone` gate-question is the one exception you voice); it's undone at Resolve when the branch integrates and the worktree/clone is removed. See [Working as a team](#working-as-a-team).
3. Resolve it with its type's engine, **zoom as needed**: fetch the full body of related/closed tickets on demand. If in doubt on a `decision` ticket, run **Grilling** + **Domain vocabulary**. If in doubt on a `build`, **stop and ask** (see the Discuss step): never auto-grill.
4. Record the resolution: a comment with the answer, `gh issue close`, add the pointer to *Decisions so far*. Then **unblock dependents**: for every ticket this one was blocking, if it was the last open blocker, remove its `trailhead:blocked` label so it graduates onto the frontier.
5. Add newly-surfaced tickets (create-then-wire, labelling blocked ones `trailhead:blocked`); graduate the fog that became specifiable, clearing the patch from *Not yet specified*. If the answer reveals a ticket sits beyond the destination, apply the **out-of-scope vs deferred** test (see [Out of scope](#out-of-scope)): if it's really deferred on something outside the map, ask the user to route it to a `seed`/`idea`/`todo`; only if it's truly beyond the destination rule it **out of scope** (label + close) instead of resolving it. If the decision invalidates other parts of the map, update or delete them.
6. **Hand off.** Close the session with the **[Session handoff](#session-handoff)** ritual: confirm the ticket is resolved by name, then the scannable **next-step block with `/clear` first** (never the next command without it), naming the next frontier ticket and giving its number, or `/trailhead:map` if the frontier is empty/ambiguous. This holds in any later follow-up too, not only at the moment of resolution. **If this resolution leaves the map exhausted** (no open tickets and no fog left: the destination is reached), say so; but **before closing it out, if *Out of scope* holds any deferred line** (apply the [out-of-scope-vs-deferred](#out-of-scope) tells), **stop and ask the user what to do with each** (a `seed` gated on its trigger, an `idea`, or a `todo`, in this or another map), so nothing wanted-later is lost when the map goes quiet. Only once the deferred items are routed (or the user says leave them), **unpin the map** (see [Substrate](#substrate-github-issues), the pin lifecycle) and **ask the user whether to close the map issue** now that the destination is reached: `gh issue close` it on a yes (it stays the record), leave it open on a no; never close a map unprompted. Codebase and conventions stay pinned regardless.

### Mode 3: Capture, `/trailhead:bug|todo|idea|seed|note`
The user fires a capture on the fly → route it per the **Capture** section and confirm with one line.

### Auxiliary verbs: `/trailhead:ticket|config|grill|split|pause|resume|update`
- **`ticket <type> <title>`**: open ticket(s) of the map on the fly, for any of the six types (`decision`, `research`, `prototype`, `build`, `bug`, `task`), the escape hatch the capture verbs don't cover. **Adding a ticket is a micro-charting act, so diverge briefly first, don't blind-commit to a single piece:** run a short breadth-first pass around the request: is this really *one* session-sized ticket, or a small **cluster** (a `decision` that needs a `research` before it, a UI `build` that needs a `prototype`, obvious siblings)? Does it imply a blocker? Surface the neighbours, *then* create the ticket(s): each gets `trailhead:ticket` + its `trailhead:<type>`, a `Parent:` line, a `## Question`; put each on the frontier, or wire `## Blocked by` + `trailhead:blocked`. This is a framing brainstorm (is this the right work?), distinct from the `decision` engine's option brainstorm (which choice?). If `<type>` is missing or invalid, ask which of the six. *(The zero-friction captures, `bug`/`todo`/`idea`/`seed`/`note`, deliberately skip this; they're one action, one confirmation.)*
- **`grill [topic|ticket]`**: run a standalone **Grilling** (+ **Domain vocabulary**) session on a decision or topic, or on a named ticket, without committing to the full work cycle. Record the outcome where it belongs: a ticket's resolution, the map's `Decisions so far`, or a fresh `decision` ticket.
- **`config`**: a **guided, menu-driven** setup (see [Configuration → Guided setup](#configuration)): pick the scope, then walk each setting as an `AskUserQuestion` menu with icon-labelled options, and write the result. `config get` prints the effective config read-only (project `.trailhead/config.json` merged over global over defaults, showing which source wins each key); `config set <key> <value>` writes one key directly: to the project `.trailhead/config.json`, or to `~/.claude/trailhead/config.json` with `--global`.
- **`split [ticket]`**: split the named (or in-play) ticket per [Splitting a ticket](#working-as-a-team): create children, supersede & close the original.
- **`pause [note]`** / **`resume [ticket]`**: checkpoint and pick back up per [Pausing & resuming](#working-as-a-team).
- **`update`**: check for a newer trailhead and install it where safe, per **`references/updating.md`** (detect the install channel, compare the installed version with the latest from the matching source, install on a go-ahead). The **`trailhead-check-update.js`** SessionStart hook keeps the check cache fresh; the statusline shows a `⬆ trailhead <version>` flag when one is available.

The user may work unblocked tickets in parallel: expect concurrent sessions editing the tracker, see [Working as a team](#working-as-a-team) for claiming, splitting, and safe map edits.
