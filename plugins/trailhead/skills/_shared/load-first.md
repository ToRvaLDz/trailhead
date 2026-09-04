# Load first, in order

The **shared-core load contract**, single-sourced here and referenced by every cluster `SKILL.md`: the dispatcher `trailhead/` and the five clusters `trailhead-chart` / `trailhead-work` / `trailhead-view` / `trailhead-capture` / `trailhead-manage`. Each cluster's own `## Load first, in order` points here in a line, then states its cluster-specific isolation posture; this file holds the part that is identical for all of them.

The paths below are written **relative to the cluster `SKILL.md` that pointed you here** (exactly as that `SKILL.md`'s own shared-core references are), so `../_shared/` resolves to this directory from any cluster.

Before doing anything, read the shared core, in order:

1. `../_shared/principles.md`: refer by name, result-oriented output, no em-dashes, git per conventions, one ticket per session.
2. `../_shared/ticket-language.md`: write all Issue prose and commit bodies in `config.ticket.language` (default `en`), independent of the chat language.
3. `../_shared/substrate.md`: the GitHub-Issues model: labels, the frontier query, the map / ticket / dashboard / whiteboard anatomy, and the base-command cookbook pointer.
4. `../_shared/session-handoff.md`: how every resolution closes (`/clear` first, then the next command).
5. `../_shared/configuration.md`: the three config layers and the load contract.
6. `../_shared/techniques.md`: the technique index and the subagent-type rule.

Load the **effective config** (per `../_shared/configuration.md`) at session start, from the map's project root (`.trailhead/config.json` plus the global file), before any isolation workspace is set up.
