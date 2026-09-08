---
description: Prune a map's closed and orphan sub-issue edges to reclaim slots under GitHub's 100-cap (references kept)
argument-hint: "[map]"
---

Invoke the `trailhead` skill for the **prune** action: call the Skill tool with skill name `trailhead-manage` and arguments `prune $ARGUMENTS`, then **read the skill's `references/pruning.md` and follow it**: that file holds the prune protocol (resolve the target map, read the sub-issue count, reconcile the map's native edges bidirectionally, preview and confirm, then apply, keeping every reference). Do not re-implement the behaviour here. The skill is the single source of truth.
