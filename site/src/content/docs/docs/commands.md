---
title: Commands
description: The full verb list, grouped by cluster, with a guide page per cluster covering every verb's syntax, steps and writes.
---

`trailhead` is user-invoked (it won't fire on its own). The first word is the verb; the rest is text or a ticket number. With no verb, `/trailhead` does smart entry: it inspects the repo and proposes the right next move.

Every verb is also a namespaced command (`/trailhead:new`, `/trailhead:work`, `/trailhead:bug`, …) so typing `/trailhead` lists them all in the command picker. `/trailhead <verb>` and `/trailhead:<verb>` are equivalent.

There are 23 verbs in five clusters. Each row below links to that verb's guide, which gives its syntax, arguments, what it does step by step, what it writes, and an example:

- [Chart](/docs/commands/chart): start a map or bring outside work into it.
- [Work](/docs/commands/work): resolve tickets and manage their lifecycle.
- [View](/docs/commands/view): read-only renders of the map, dashboard and whiteboard.
- [Capture](/docs/commands/capture): zero-friction capture of tickets, fog and notes.
- [Manage](/docs/commands/manage): config, update, prune, and audit.

## Smart entry

| Command | What it does |
|---|---|
| `/trailhead` | smart entry: detect state and propose |

## Chart

Give a map its start, or bring outside work into it. [Full guide](/docs/commands/chart).

| Command | What it does |
|---|---|
| [`/trailhead:new [idea]`](/docs/commands/chart#new) | chart a new map from a loose idea |
| [`/trailhead:adopt`](/docs/commands/chart#adopt) | adopt an existing project (map the codebase once, then go lean) |
| [`/trailhead:ticket <type> <title>`](/docs/commands/chart#ticket) | open a ticket on the fly (diverges briefly first: a micro-charting act) |
| [`/trailhead:inbox [issue]`](/docs/commands/chart#inbox) | triage issues opened by others and integrate the good ones into the map |
| [`/trailhead:grill [topic]`](/docs/commands/chart#grill) | run a standalone grilling session on a decision/topic |

## Work

Resolve tickets and manage a ticket's lifecycle. [Full guide](/docs/commands/work).

| Command | What it does |
|---|---|
| [`/trailhead:work [ticket]`](/docs/commands/work#work) | work the next frontier ticket, or the one you name |
| [`/trailhead:quick [ticket \| "text"]`](/docs/commands/work#quick) | work one ticket whole, never splitting: `"text"` opens a whiteboard ticket off the map; `<n>` takes an existing ticket (a map ticket stays on its map), runs the full engine, grills only if needed |
| [`/trailhead:pause [note]`](/docs/commands/work#pause) | checkpoint the ticket in play so anyone can resume it |
| [`/trailhead:resume [ticket]`](/docs/commands/work#resume) | resume a paused ticket from its `PAUSED` checkpoint |
| [`/trailhead:split [ticket]`](/docs/commands/work#split) | split an oversized ticket into children, supersede the original |
| [`/trailhead:auto [map]`](/docs/commands/work#auto) | run the frontier autonomously, one ticket after another, until a stop condition (safety rail / fog / a human-necessary decision) or exhaustion; suspends one-ticket-per-session |

## View

Read-only renders of where the work stands. [Full guide](/docs/commands/view).

| Command | What it does |
|---|---|
| [`/trailhead:map`](/docs/commands/view#map) | show the low-res map (destination, decisions, frontier, fog) |
| [`/trailhead:dashboard`](/docs/commands/view#dashboard) | show the repo dashboard: the pinned index of every open map, the whiteboard, and live counts |
| [`/trailhead:whiteboard`](/docs/commands/view#whiteboard) | show the whiteboard: the loose (map-less) tickets and their frontier |

## Capture: zero friction, one confirmation line, resolves nothing

[Full guide](/docs/commands/capture).

| Command | Lands as | Meaning |
|---|---|---|
| [`/trailhead:todo <text>`](/docs/commands/capture#todo) | a frontier ticket | *I'm doing it*: defined work, now |
| [`/trailhead:seed <text>`](/docs/commands/capture#seed) | a blocked ticket (trigger noted) | *I'll do it when X happens* |
| [`/trailhead:idea <text>`](/docs/commands/capture#idea) | the fog (`Not yet specified`) | *maybe I'll do it*: graduates to a ticket if it sharpens |
| [`/trailhead:note <text>`](/docs/commands/capture#note) | verbatim text | *remember this*: not necessarily work |
| [`/trailhead:bug [--of <ticket>] <text>`](/docs/commands/capture#bug) | a `bug` ticket | a defect; `--of` records it as a `Regression of:` a closed ticket |

The four fog/ticket captures form a spectrum of commitment and timing: note < idea < seed < todo. See [Captures & the whiteboard](/docs/captures) for the full spectrum and the whiteboard.

## Manage

Keep the install and the maps healthy. [Full guide](/docs/commands/manage).

| Command | What it does |
|---|---|
| [`/trailhead:config [get \| set …]`](/docs/commands/manage#config) | the guided, menu-driven setup for `.trailhead/config.json`, or read and write one key; see [Configuration](/docs/configuration) |
| [`/trailhead:update`](/docs/commands/manage#update) | check for a newer trailhead and install it, detecting how it was installed (dev-symlink, npm, or plugin) |
| [`/trailhead:prune [map]`](/docs/commands/manage#prune) | reclaim a map's native sub-issue slots under GitHub's 100 sub-issue cap by dropping the edges of closed and orphan tickets (every reference kept); offered automatically when a map is near or at the cap |
| [`/trailhead:audit [map] [--all]`](/docs/commands/manage#audit) | hunt regressions by checking that the tickets closed since the last audit are still true against the current code, and compare the open ones for duplicates and groupable clusters; read-only until you confirm, and every fix is a proposal applied only on an explicit yes |

Next: [chart commands](/docs/commands/chart), the first of the five guides, or jump to [Captures & the whiteboard](/docs/captures) for the commitment spectrum and [Working as a team](/docs/teamwork) for how these commands behave with multiple contributors.
