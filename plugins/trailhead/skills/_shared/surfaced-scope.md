# Scope that surfaces while working a ticket

The rule every engine, technique and capture points at when new work turns up mid-ticket (while planning, executing, reviewing, or testing). Read it whenever you are about to open a ticket that the ticket in flight sparked.

## Do it, split it, or capture it
Testing or building X often sparks new ideas: do **not** grow X in flight; a ticket is one answerable Question, sized to one session. Decide per idea:
- part of X's Question and small → just do it in X (that's completing X, not expanding it);
- it balloons X past one session → **`split`** X (children carry the new pieces, supersede the original);
- separate work or a follow-up beyond X's goal → **capture and continue** (`idea`/`todo`/`ticket`/`bug --of X`), don't derail.

Tickets born this way carry a **`Surfaced from: <ticket name+link>`** line in their body (the same lineage convention as `Split from:` and `Regression of:`) so where an idea came from stays visible. Never let extras become silent lines inside X: the map stays honest by spinning them into their own tickets or fog.

## Where the surfaced ticket lands (never the whiteboard by default)
A surfaced ticket lands on a **map** or on the **whiteboard**, by the first rule that fits. Eligible maps are the **open** ones (`gh issue list --label "trailhead:map" --state open`), exhausted-but-open included, exactly as the capture rule in `../trailhead-capture/references/capture.md` (**Map or whiteboard**).
1. **The current map, when the topic is its own.** X is on an open map and the new work serves that map's destination (not a line its *Out of scope* rules out): land it there (its `trailhead:map-<n>` label, native sub-issue edge, `Parent:`), no ask.
2. **Another open map, when the topic clearly is that map's.** The new work plainly serves the destination of a *different* open map (read the maps' titles and destinations, not their tickets): land it there, no ask.
3. **Otherwise, ask.** When neither fits with confidence (the topic is ambiguous, spans maps, or fits none, or X is a whiteboard ticket while maps are open), **ask before creating it**: one `AskUserQuestion` (a numbered list on a host without a structured question tool) listing **every open map by name and number, the current map first and marked as such, then the whiteboard**, with your best guess as the Recommended first option. **Never route to the whiteboard without this ask while any map is open**: the whiteboard is a destination the user picks, not the fallback for "not sure".
4. **No map open → whiteboard, no ask** (nowhere else to go).

A `bug --of <ticket>` keeps its inherit-the-origin rule (`capture.md`, the `bug` bullet), which already settles the destination. **Under an autonomous run** (`auto`), rules 1, 2 and 4 apply unchanged; a case that falls to rule 3 is a human decision, so do not guess: record it as a pending follow-up (the **Pending follow-up guard** in `session-handoff.md`) and name it in the run-end summary.

## Say what you opened, and where
Right after creating it, tell the user in one line, in their conversation language: the ticket's name and number, and **where it landed**: the map by name and number, or the whiteboard (e.g. *Opened Add login rate limit (#45) on map Auth rework (#12)*). Add *why there* in a few words when the landing was inferred (rules 1 and 2), so a wrong guess is easy to spot and move. Then continue with X. A whiteboard landing refreshes the dashboard per the capture rule; a map landing does not.
