---
title: "Chart commands"
description: "new, adopt, ticket, inbox, and grill: the verbs that give a map its start or bring outside work into it."
---

The chart verbs give a map its start or bring outside work into it. `/trailhead <verb>` and `/trailhead:<verb>` are equivalent. Everything these verbs write lands on GitHub Issues; the repo itself holds code only. Back to the [command index](/docs/commands).

<h3 id="new">/trailhead:new</h3>

Chart a new map from a loose idea.

**Syntax**

```
/trailhead:new [idea]
```

**Arguments**

- `idea` (optional): the loose idea in your own words. Without it, trailhead asks what you want to build.

**What it does**

1. Checks that the current directory has a GitHub repo. If there is none, it stops and asks whether to create one (private by default, or public); decline and charting ends there.
2. Grills you to name the destination (what this map tends toward), using the Grilling and Domain vocabulary techniques.
3. Maps the frontier breadth-first: it enumerates every functional area the destination implies before deep-diving any one. If nothing is foggy (the whole thing fits one session) it says so and asks how to proceed instead of making a map. If earlier maps left parked seeds, todos or ideas, it asks which belong in this one.
4. Creates the map, runs the first-use repo setup (labels and the label guard), and sets up the `trailhead:conventions` issue through a short brainstorm (`git`, `release`, `isolation`, plus the way of working a newcomer would need). It also creates and pins the dashboard.
5. Creates the tickets it can specify now, wires the blockers, and fires research tickets in parallel.
6. Offers the one-time config choice (accept defaults or run `/trailhead:config`), then stops with a next-step block. Charting resolves nothing; it is one session's work.

**What it writes**

- The map issue (`trailhead:map`) and its per-map label `trailhead:map-<n>`; every ticket carries that label and is a native sub-issue of the map.
- Ticket issues (`trailhead:ticket` plus a type label), with `trailhead:blocked` already set at creation where a blocker exists.
- The `trailhead:conventions` issue and the pinned `trailhead:dashboard` (created if missing, refreshed otherwise).
- If another map is already open, the new map runs alongside it and becomes the active map (`.trailhead/active-map`).
- `.trailhead/config.json` only if you accept the config offer (`{}` for "accept as-is").

**Example**

```
/trailhead:new a CLI that syncs my notes to S3
```

trailhead grills the destination, shows the fog and the first tickets, then closes with: clear the context, run `/trailhead:work <n>` on the first frontier ticket (or `/trailhead:map` to look first).

<h3 id="adopt">/trailhead:adopt</h3>

Adopt an existing project: map the codebase once, then go lean.

**Syntax**

```
/trailhead:adopt
```

**Arguments**

None.

**What it does**

1. Looks for the repo's `trailhead:codebase` issue. If one exists and the code has not drifted, it links it; otherwise it maps the codebase with a parallel fan-out of readers and distils the result into that issue. This heavy step runs once per repo, not per map.
2. Grills the destination of the remaining stretch ("what is left to reach working"), seeded by the codebase map.
3. Backfills decisions already embodied in the code as ticket-less lines under Decisions so far, so the map does not pretend to be greenfield.
4. Maps the frontier of the remainder breadth-first, harvests parked work from earlier maps, and creates the tickets and blockers as `new` does.
5. Sets up conventions seeded from what it can discover (`CLAUDE.md`/`AGENTS.md`, CI, git history, scripts, deploy config) and proposes values for you to correct. It detects a monorepo (suggests `Scope:` lines) and git submodules (a submodule superrepo resolves to `clone` isolation), and prefers `isolation: clone` for path-bound tooling such as React Native or Expo.
6. Ends with the same config offer and next-step block as `new`.

**What it writes**

- The `trailhead:codebase` issue (once per repo), the map and its tickets, the `trailhead:conventions` issue, and the pinned dashboard.
- Missing `trailhead:*` labels and the label-guard workflow (first-use repo setup).

**Example**

```
/trailhead:adopt
```

After the mapping fan-out, trailhead proposes the conventions it inferred (for example a monorepo with `isolation: auto`), asks you to confirm or correct them, then lists the frontier.

<h3 id="ticket">/trailhead:ticket</h3>

Open a ticket of any type on the fly.

**Syntax**

```
/trailhead:ticket <type> <title>
```

**Arguments**

- `type` (required): one of `decision`, `research`, `prototype`, `build`, `bug`, `task`. If missing or invalid, trailhead asks which of the six.
- `title` (required): what the ticket is about.

**What it does**

1. Diverges briefly first: opening a ticket is a micro-charting act, so it checks whether this is really one session-sized ticket or a small cluster (a decision that needs a research before it, a UI build that needs a prototype), and whether it implies a blocker.
2. Surfaces those neighbours to you, then creates the ticket or tickets. Anything known to be blocked is created already blocked and wired to its blocker.

**What it writes**

- Each ticket: `trailhead:ticket` plus its type label, the map's `trailhead:map-<n>` label, a native sub-issue edge to the map, a `Parent:` line, and a `## Question`.
- Blocker wiring (`## Blocked by` plus the native dependency, and `trailhead:blocked`) where it applies.

The zero-friction captures (`bug`, `todo`, `idea`, `seed`, `note`) skip the diverge step; see [capture commands](/docs/commands/capture).

**Example**

```
/trailhead:ticket decision which payment provider
```

trailhead points out that a `research` ticket comparing providers should come first, creates both, and shows the research on the frontier with the decision blocked behind it.

<h3 id="inbox">/trailhead:inbox</h3>

Triage issues opened by others and integrate the worthwhile ones into the map.

**Syntax**

```
/trailhead:inbox [issue]
```

**Arguments**

- `issue` (optional): an issue number to triage just that one.

**What it does**

1. Shows three sections by name: incoming issues to triage (open issues with no `trailhead:*` label, plus anything the trust guard marked `trailhead:unverified`), parked fog ready to graduate (open `trailhead:fog` issues, most recently active first), and out-of-scope lines that are actually deferred.
2. For each incoming issue it decides with you on judgement calls, and alone on clear ones: adopt as a ticket, park as fog, mark out of scope, mark duplicate, or ask the reporter for more information.
3. For parked fog it asks whether to graduate it, keep it parked, or drop it.
4. For out-of-scope lines that name a gate or a later feature, it asks how to re-route each (`seed`, `idea` or `todo`, and which map), wiring gate-first with a live trigger and moving the whole cluster together.

**What it writes**

- Adopted issues are changed in place (same number, reporter stays credited): a trailhead block is appended below the original text (`Parent:`, `Adopted-from: opened by @<author>`, a reframed `## Question`, `## Blocked by`), with the ticket and type labels, the map label and the sub-issue edge. A comment tells the reporter it was picked up.
- Fog: the issue stays open with `trailhead:fog` and a comment of clarifying questions; later it can be adopted in place.
- Out of scope: `trailhead:out-of-scope`, the sub-issue edge dropped to reclaim a slot, then closed with the reason. Duplicates are linked and closed; needs-info stays open with a question.
- Updated *Out of scope* lines on the map for anything re-routed.

**Example**

```
/trailhead:inbox
```

trailhead lists, for example, two incoming issues, one fog item that just got new comments, and one deferred out-of-scope line, and walks you through each.

<h3 id="grill">/trailhead:grill</h3>

Run a standalone grilling session on a decision or topic.

**Syntax**

```
/trailhead:grill [topic|ticket]
```

**Arguments**

- `topic` (optional): a decision or topic to grill, in free text.
- `ticket` (optional): the number of an existing ticket to grill without starting its full work cycle.

**What it does**

1. Runs the Grilling technique plus Domain vocabulary on the topic or ticket, asking one pointed question at a time until the decision is sharp.
2. Records the outcome where it belongs: the ticket's resolution, the map's Decisions so far, or a fresh `decision` ticket.
3. If the decision unblocks or spawns follow-on tickets, it asks which destination to open them in (a thematically fitting open map, or the whiteboard). Only when no map is open do they go to the whiteboard without asking.

**What it writes**

- A resolution comment on the ticket, a line under Decisions so far, or a new `decision` ticket, whichever you chose.
- Any follow-on tickets, on the map or the whiteboard as you decided.

**Example**

```
/trailhead:grill should sync be push or pull
```

trailhead asks the questions that separate the options, then proposes recording the outcome as a decision ticket on the active map.

Next: [work commands](/docs/commands/work) to take the tickets you just charted.
