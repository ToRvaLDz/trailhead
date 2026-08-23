---
description: Resume a paused ticket from its checkpoint
argument-hint: "[ticket]"
---

Invoke the `trailhead` skill for the **resume** action: call the Skill tool with skill name `trailhead-work` and arguments `resume $ARGUMENTS`, then **read the teamwork reference the skill points to (`../_shared/teamwork.md`) and follow it**: that file holds the pausing & resuming protocol (including, under `isolation: worktree`/`clone`, re-entering the ticket's isolated workspace recorded in its checkpoint). Do not re-implement the behaviour here. The skill is the single source of truth.
