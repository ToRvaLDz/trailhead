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

**Host command forms (standing render rule).** Every trailhead command you write in prose you generate at runtime, the session handoff, a capture confirmation, any next-step suggestion, and not only where a doc example already shows one, uses **this host's command forms**: `/clear` to clear context, and the `/trailhead:<verb>` family (`/trailhead:work <n>`, `/trailhead:quick <n>`, `/trailhead:map`, `/trailhead:dashboard`). These literals are this host's surface. **Never emit a command form that belongs to a different host** (one you may have read elsewhere in this repository, such as in the projection code and its tests, or earlier in the session): the forms stated in this contract are the only ones correct for the host you are running on.

Load the **effective config** (per `../_shared/configuration.md`) at session start, from the map's project root (`.trailhead/config.json` plus the global file), before any isolation workspace is set up.

**Pinned model review, once per session.** After loading the effective config, run the read-only check: `node <lib> check <project root>`, where `<lib>` is the first of these two paths (relative to this `_shared/` dir) that exists: `../../hooks/lib/model-defaults-review.js` (Claude plugin, Claude npm copy, dev-symlink install), else `../trailhead/hooks/lib/model-defaults-review.js` (Codex). If neither exists, skip silently. If it prints a notice, offer it to the user without blocking the current request; only after the user answers any of its three choices, run `node <lib> ack <project root>`. Do this at most once per session: skip it if the SessionStart hook (or an earlier config load this session) already surfaced the same offer. Repeats across sessions are expected until the user answers.

**Label guard check, once per session.** Same pattern for the repo's label guard: run `node <templates>/trailhead-label-guard-sync.js --repo <project root> --notice`, with `<templates>` resolved as for the commit-msg sync script (see `teamwork.md`, Trust & provenance → Repo-side enforcement; skip silently if none of the template dirs has the script). It prints an offer only when the committed guard is the outdated one (no job-level `if:`, so every label event bills a runner) and the user has not answered for that file yet. Offer it without blocking the current request and follow its instructions; only after the user picks either choice, run the `--ack` command it names. At most once per session: skip it if the SessionStart hook already surfaced it.
