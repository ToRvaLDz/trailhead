---
description: Run a standalone grilling session on a decision or topic
argument-hint: "[topic|ticket]"
---

Run the **grill** action of the `trailhead` skill.

The skill is not model-invocable via the Skill tool (`disable-model-invocation`), so do **not** call the Skill tool. Instead load it by reading `${CLAUDE_PLUGIN_ROOT}/skills/trailhead/SKILL.md`, then carry out its instructions for the **grill** verb with arguments `grill $ARGUMENTS`. Resolve any `references/…` paths relative to `${CLAUDE_PLUGIN_ROOT}/skills/trailhead/`. The SKILL.md is the single source of truth — do not re-implement the behaviour here.
