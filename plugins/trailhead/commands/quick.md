---
description: Work one ticket whole, off the map (whiteboard); grills only if needed, never splits
argument-hint: "[ticket | \"text\"]"
---

Invoke the `trailhead` skill for the **quick** action: call the Skill tool with skill name `trailhead-work` and arguments `quick $ARGUMENTS`, then carry out the skill's instructions for that verb (open a `trailhead:whiteboard` ticket from the `"text"`, or take the existing ticket you name, then run the full engine on it without splitting and without map book-keeping). Do not re-implement the behaviour here. The skill is the single source of truth.

**When `quick "<text>"` opens a NEW whiteboard ticket, refresh the pinned `trailhead:dashboard` at the handoff (Resolve), not at ticket creation** (the whiteboard has no native progress bar, so the dashboard is where the ticket shows; a quick is born and resolved in one session, so the refresh rides with its end, a full regeneration from the live tracker, never a mid-work partial patch). If the session pauses before Resolve (`/trailhead:pause`), refresh there instead. `quick <n>` on an existing *map* ticket does not refresh. See the skill's *quick* section and the dashboard freshness rule.
