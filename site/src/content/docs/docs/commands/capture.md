---
title: "Capture commands"
description: "todo, seed, idea, note, and bug: one line in, one confirmation out, nothing resolved."
---

Capture without breaking flow: one action, one confirmation line, and nothing is resolved. Every capture writes at most one issue and sets up no isolation workspace. For how the five differ in commitment, see [Captures & the whiteboard](/docs/captures). Back to the [command index](/docs/commands).

Rules shared by all five:

- **Language.** A captured ticket is written in `ticket.language` (default `en`), whatever language you typed the capture in.
- **Map or whiteboard.** A capture that produces a ticket (`todo`, `bug`, `seed`, and a sharp `idea`) goes to a map or to the whiteboard. With a map open, trailhead asks which (an exhausted-but-still-open map is a valid target; a closed one is not). With no map open it lands on the whiteboard without asking. `note` and a non-sharp `idea` stay as map fog.
- **Dashboard.** When a capture creates a whiteboard ticket, the pinned dashboard is refreshed; a capture landing on a map is not (the map's native progress bar tracks it).
- **Confirmation line.** The capture is confirmed by the ticket's name and number and where it landed. If it points at working the ticket later, it leads with `/clear`, then `/trailhead:work <n>`, with `/trailhead:quick <n>` as the lighter alternative.

<h3 id="todo">/trailhead:todo</h3>

Capture a small build ticket: defined work you will do now.

**Syntax**

```
/trailhead:todo <text>
```

**Arguments**

- `text` (required): what to do. If missing, trailhead asks for it.

**What it does**

1. Asks map or whiteboard when a map is open.
2. Creates a small `build` ticket and confirms with its name and number.
3. If what you described is a parking spot beyond the destination, it goes under the map's Out of scope instead.

**What it writes**

- A `trailhead:build` ticket on the frontier (with the map label and sub-issue edge on a map, or `trailhead:whiteboard` without a map label or `Parent:`). Workable immediately.
- The dashboard, if the ticket landed on the whiteboard.

**Example**

```
/trailhead:todo add a rate limit to the login endpoint
```

trailhead confirms: *Add login rate limit* (#45) is on the frontier. To work it later: `/clear`, then `/trailhead:work 45`.

<h3 id="seed">/trailhead:seed</h3>

Capture a seed: work gated on a future trigger.

**Syntax**

```
/trailhead:seed <text>
```

**Arguments**

- `text` (required): the work and the trigger that should release it ("when the public API ships").

**What it does**

1. Asks map or whiteboard when a map is open.
2. Creates a parked ticket that waits on its trigger, and confirms with its name and number. The confirmation does not point at working it, because it is not workable yet.
3. When the trigger fires, the two labels are dropped and the seed graduates onto the frontier.

**What it writes**

- A ticket labelled `trailhead:seed` and `trailhead:blocked`, with the trigger noted in the body and kept in its own `## Blocked by`.
- The dashboard, if it landed on the whiteboard.

**Example**

```
/trailhead:seed support SSO once we pass 1k users
```

trailhead files a parked ticket with the trigger "1k users" and tells you it will wait there until then.

<h3 id="idea">/trailhead:idea</h3>

Capture an idea into the fog (Not yet specified).

**Syntax**

```
/trailhead:idea <text>
```

**Arguments**

- `text` (required): the idea, in a line.

**What it does**

1. Records it as fog under the map's *Not yet specified*. An idea in the fog is not executable: it graduates into a ticket later, when the frontier reaches it or you can phrase it as a sharp question.
2. If the idea is already a sharp question, it becomes a ticket instead, and then follows the map-or-whiteboard ask. With no open map, a non-sharp idea falls back to the global notes location and a sharp one becomes a whiteboard ticket.

**What it writes**

- A line under `## Not yet specified` on the map (or, for a sharp idea, a ticket as above). Nothing is rewritten beyond the confirmation.

**Example**

```
/trailhead:idea a dark mode toggle maybe
```

trailhead confirms the idea is parked in the map's fog and not yet a ticket.

<h3 id="note">/trailhead:note</h3>

Capture a verbatim note.

**Syntax**

```
/trailhead:note <text>
```

**Arguments**

- `text` (required): the text to remember.

**What it does**

1. Stores your text as is: no questions, no rewriting, and no map-or-whiteboard ask. A note is raw text to remember, not necessarily work.
2. Confirms where it landed.

**What it writes**

- A verbatim line under `## Not yet specified` on the open map, or, outside a project, a file under `$HOME/.claude/notes/`.

**Example**

```
/trailhead:note the staging DB is reset every Sunday night
```

trailhead confirms the line is stored in the map's fog exactly as typed.

<h3 id="bug">/trailhead:bug</h3>

Capture a bug ticket; use `--of` for a regression.

**Syntax**

```
/trailhead:bug [--of <ticket>] <text>
```

**Arguments**

- `text` (required): what is wrong, with the repro if you know it.
- `--of <ticket>` (optional): a ticket number, `#n`, name or URL. Use it for a defect in already-closed work: it records a `Regression of: <ticket>` pointer in the body. A bug in closed work is always a new ticket, never a reopen (the one exception is a ticket closed before its Verify ever passed).

**What it does**

1. Asks map or whiteboard when a map is open.
2. Creates the `bug` ticket and confirms. It does not derail you: capture and continue, and resolve it in a dedicated session.
3. If the bug blocks the ticket you are working, it is added to that ticket's `## Blocked by` and that ticket gets `trailhead:blocked`.

**What it writes**

- A `trailhead:bug` ticket on the frontier, with the repro and, under `--of`, the `Regression of:` line.
- The blocker wiring and label on the blocked ticket, where it applies.
- The dashboard, if the bug landed on the whiteboard.

**Example**

```
/trailhead:bug --of 31 login redirect loops when the cookie is expired
```

trailhead files a bug that records it as a regression of #31 and asks whether it belongs on the active map or the whiteboard.

Next: [manage commands](/docs/commands/manage) for config, update, prune and audit.
