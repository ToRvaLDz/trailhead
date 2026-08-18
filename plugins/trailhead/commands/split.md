---
description: Split an oversized ticket into children and supersede it
argument-hint: "[ticket]"
---

Run the **split** action of the `trailhead` skill.

The skill is not model-invocable via the Skill tool (`disable-model-invocation`), so do **not** call the Skill tool. Instead load it by reading `${CLAUDE_PLUGIN_ROOT}/skills/trailhead/SKILL.md`, then carry out its instructions for the **split** verb with arguments `split $ARGUMENTS`. Resolve any `references/…` paths relative to `${CLAUDE_PLUGIN_ROOT}/skills/trailhead/`. The SKILL.md is the single source of truth — do not re-implement the behaviour here.
