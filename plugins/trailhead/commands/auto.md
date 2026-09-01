---
description: Run the frontier autonomously until a stop condition or exhaustion
argument-hint: "[map]"
---

Invoke the `trailhead` skill for the **auto** action: call the Skill tool with skill name `trailhead-work` and arguments `auto $ARGUMENTS`, then carry out the skill's instructions for that verb, per the auto engine in `references/auto.md` (the whole-frontier autonomous run: suspends one-ticket-per-session, takes advisory choices as delegate without the confirm gate, and stops only at the safety rail, fog, human-necessary decisions, or human interrupt). Do not re-implement the behaviour here. The skill is the single source of truth.
