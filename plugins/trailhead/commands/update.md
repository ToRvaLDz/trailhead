---
description: Check for a newer trailhead and install it
---

Invoke the `trailhead` skill for the **update** action: call the Skill tool with skill name `trailhead-manage` and arguments `update $ARGUMENTS`, then **read the skill's `references/updating.md` and follow it**: that file holds the update protocol (detect the install channel, compare versions, install the newer one where it is safe). Do not re-implement the behaviour here. The skill is the single source of truth.
