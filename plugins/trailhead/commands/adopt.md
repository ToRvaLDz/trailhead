---
description: Adopt an existing project — map the codebase once, then go lean
argument-hint: ""
---

Run the **adopt** action of the `trailhead` skill.

The skill is not model-invocable via the Skill tool (`disable-model-invocation`), so do **not** call the Skill tool. Instead load it by reading `${CLAUDE_PLUGIN_ROOT}/skills/trailhead/SKILL.md`, then carry out its instructions for the **adopt** verb with arguments `adopt $ARGUMENTS`. Resolve any `references/…` paths relative to `${CLAUDE_PLUGIN_ROOT}/skills/trailhead/`. The SKILL.md is the single source of truth — do not re-implement the behaviour here.
