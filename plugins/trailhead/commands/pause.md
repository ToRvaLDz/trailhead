---
description: Checkpoint the ticket in play so it can be resumed later
argument-hint: "[note]"
---

Invoke the `trailhead` skill for the **pause** action: call the Skill tool with skill name `trailhead-work` and arguments `pause $ARGUMENTS`, then **read the teamwork reference the skill points to (`../_shared/teamwork.md`) and follow it**: that file holds the pausing & resuming protocol (including, under `isolation: worktree`/`clone`, committing the work-in-progress in the ticket's isolated workspace and recording its path in the checkpoint). Do not re-implement the behaviour here. The skill is the single source of truth.
