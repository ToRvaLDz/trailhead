---
title: Commands
description: The full verb list, flow and capture, plus config and update.
---

`trailhead` is user-invoked (it won't fire on its own). The first word is the verb; the rest is text or a ticket number. With no verb, `/trailhead` does smart entry: it inspects the repo and proposes the right next move.

Every verb is also a namespaced command (`/trailhead:new`, `/trailhead:work`, `/trailhead:bug`, …) so typing `/trailhead` lists them all in the command picker. `/trailhead <verb>` and `/trailhead:<verb>` are equivalent.

## Flow

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

## Capture: zero friction, one confirmation line, resolves nothing

| Command | Lands as | Meaning |
|---|---|---|
| `/trailhead:todo <text>` | a frontier ticket | *I'm doing it*: defined work, now |
| `/trailhead:seed <text>` | a blocked ticket (trigger noted) | *I'll do it when X happens* |
| `/trailhead:idea <text>` | the fog (`Not yet specified`) | *maybe I'll do it*: graduates to a ticket if it sharpens |
| `/trailhead:note <text>` | verbatim text | *remember this*: not necessarily work |
| `/trailhead:bug [--of <ticket>] <text>` | a `bug` ticket | a defect; `--of` records it as a `Regression of:` a closed ticket |

The four fog/ticket captures form a spectrum of commitment and timing: note < idea < seed < todo. See [Captures & the whiteboard](/docs/captures) for the full spectrum and the whiteboard.

## Config and update

Two more verbs round out the surface, documented in their own sections:

- **`/trailhead:config`**: the guided, menu-driven setup for `.trailhead/config.json`; see [Configuration](/docs/configuration).
- **`/trailhead:update`**: re-installs trailhead to the newer version, detecting how it was installed (dev-symlink, npm, or plugin); see [Getting started](/docs/getting-started).

Next: [Captures & the whiteboard](/docs/captures) for the commitment spectrum, or [Working as a team](/docs/teamwork) for how these commands behave with multiple contributors.
