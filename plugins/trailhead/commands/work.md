---
description: Work the next frontier ticket, or the one you name
argument-hint: "[ticket]"
---

Invoke the `trailhead` skill for the **work** action: call the Skill tool with skill name `trailhead` and arguments `work $ARGUMENTS`, then carry out the skill's instructions for that verb (under the repo's `trailhead:conventions` `isolation: worktree`, work the ticket in its own `git worktree` + `trailhead/t<n>` branch, per `references/teamwork.md`). Do not re-implement the behaviour here. The skill is the single source of truth.
