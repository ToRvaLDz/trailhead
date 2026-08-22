# Changelog

All notable changes to trailhead are recorded here. This project follows [Semantic Versioning](https://semver.org).

## Unreleased

### Changed / Fixed
- **A capture's confirmation must lead with `/clear` when it points at working the ticket.** A `bug`/`todo`/… confirmation that ended with a bare "to work it: `/trailhead:work 45`" skipped the Session-handoff `/clear`-first rule. The rule now explicitly covers capture confirmations: a compact future-conditional one-liner is fine (a capture is not a resolution, so no full labelled block), but `/clear` before `/trailhead:work <n>` is non-negotiable.
- **Result-oriented output rule now names the executor/model leak explicitly.** The rule against narrating internal machinery already covered "which model ran a step", but was slipping on messages like "I'll hand this to an executor on `claude-sonnet-5` (per `models.execute`)". It now spells out that fan-out is invisible to the user: no `executor` role name, no model id, no `models.*` key — it's just "an agent".
- **Statusline shows the real project from a worktree/clone, with a `(WT)`/`(C)` tag.** The project name is now taken from the main repo (via `git-common-dir`), so a worktree no longer shows its own folder name (e.g. `wt-main`) in place of the project. When the session works in an isolated checkout, a compact tag sits next to the branch — `(WT)` for a linked worktree, `(C)` for a per-ticket clone (`../<repo>-t<n>`, whose `-t<n>` suffix is stripped from the shown project) — and nothing on the original checkout.
- **The statusline's ticket line now shows for `quick` and resumed sessions too.** The `.trailhead/session-ticket` marker (what the statusline's second line reads) was only guaranteed by `work`. `quick` wrote it only under `isolation: worktree`/`clone`, so a `quick` task under `isolation: none` (the default — one checkout, working on `main`) left no marker and no `trailhead/t<n>` branch, so the statusline had nothing to show. And a resume after a released pause never re-wrote the marker it had removed. Both now write the marker in every isolation mode, matching `work`.
- **A new whiteboard ticket now refreshes the dashboard.** Creating a whiteboard ticket (`/trailhead:quick "<text>"` or a capture routed to the whiteboard) — and resolving one — is now a **structural event** that rewrites the pinned `trailhead:dashboard`, so loose work shows up in its whiteboard section and count without waiting for a manual `/trailhead:dashboard`. Map tickets are unchanged (their native sub-issue progress bars already track them); the whiteboard has no such bar, so the dashboard is the only place its tickets show. Freshness rule, the dashboard/whiteboard/quick sections, and the capture reference all updated.

## 0.3.0 (2026-08-21)

### Added
- **The whiteboard: map-less tickets.** Loose work that belongs to no map (a bug, a todo, a one-off task) now lives on the **whiteboard**: tickets labelled `trailhead:whiteboard`, with their own frontier, excluded from every map frontier. New `/trailhead:whiteboard` view. Ticket-producing captures (`todo`/`bug`/`seed`/sharp `idea`) ask, when a map is open, whether the ticket lands on the active map or the whiteboard.
- **`/trailhead:quick`: work one ticket whole, off the map.** `quick "<text>"` opens a whiteboard ticket and works it end to end now; `quick <n>` works an existing one. Runs the full discuss→plan→execute→verify engine, grills only if needed, never splits. Bare `/trailhead:quick` asks for the piece.
- **The dashboard: a pinned per-repo index.** A single `trailhead:dashboard` issue, pinned in the fixed 3rd slot (alongside codebase + conventions), indexes every open map (native progress bars), the whiteboard, and live counts. New `/trailhead:dashboard` regenerates and shows it. Read-only entry points (`/trailhead`, `/trailhead:map`, `/trailhead:whiteboard`) **self-heal** the pin, so a repo that adopted trailhead before the dashboard existed gets one on the next bare `/trailhead`.

### Changed / Fixed
- **Smart entry no longer dead-ends on an empty frontier.** When a map is complete-except-gated (everything left is gated or still fog), smart entry lays out the sensible next moves and surfaces `/trailhead:quick` as the off-map path, alongside `/trailhead:map`, `/trailhead:whiteboard`, `/trailhead:new`, and the captures.
- **Session handoff offers off-map work.** The handoff block may now offer `/trailhead:quick` after `/clear`, carrying its seed text when a concrete off-map piece is at hand. The free-text rule is restated by its real reason (a handoff command must be self-sufficient or safe to hand-type): `work` always takes a number, `:ticket` is never pre-filled (it needs the diverge-first framing), and `quick`'s forgiving seed text is the one argument allowed there.
- **`work <n>` can take a whiteboard ticket**; bare `work` stays on the map.
- **Ticket-language rule** now names `quick` explicitly: the `"<text>"` seed is chat-language input, but the ticket it opens is written in `config.ticket.language`.
- Technique subagents pinned to built-in agent types.
- **Command frontmatter fix.** Quoted the `description:` in `todo`/`adopt`/`seed` (each held an internal `: `, which YAML read as a nested mapping and rejected). All command frontmatter now parses.

### Docs
- README documents the whiteboard and quick; argument-hint, smart entry, and capture surfaces updated.

## 0.2.0 (2026-08-21)

### Added
- **Concurrent maps on one repo (park & switch).** A repo can carry more than one live map, each with its own scoped frontier, kept separate by a native GitHub **sub-issue** edge (structure/UI) plus a per-map **`trailhead:map-<n>` label** (the one-query key). An `.trailhead/active-map` marker picks which map a session works; park one and work another by pausing and switching.
- **Deferred vs out-of-scope.** Work that is not truly beyond the destination but waits on something outside the map is now **deferred**, not buried: it is captured as a real artifact (a `seed`, `idea`, or `todo`, asked, in this map or a future one), never a dead text line. Future-map work is a parked todo, **harvested** (todos and ideas) when the next map is charted.
- **Codebase issue lifecycle.** A greenfield map creates its `trailhead:codebase` issue once the repo has substantial code (not at chart), and the issue is **kept fresh incrementally at Resolve** when a ticket materially changes the map.
- **Clone-isolation gate.** Because `isolation: clone` is heavy, trailhead now asks first whether concurrent work on the same machine is planned, and skips the clone when a single ticket is being worked.

### Changed / Fixed
- **Ticket commits thread into their ticket** via a non-closing `Refs: #<n>` trailer (never `fixes`/`closes`, the ticket closes explicitly at Resolve).
- **First-time config offer** is an explicit "accept as-is vs `/trailhead:config`" choice, not an inline key-by-key interview.
- **Per-map label** lives on tickets only, never on the map issue itself.
- **`/trailhead:map`** stays read-only: it flags deferred out-of-scope lines and suggests `/trailhead:inbox`, which does the actual re-route (new inbox section for the sweep).
- **Cross-AI plan review** sets an explicit long Bash timeout (or runs in the background) so long reviewer CLIs are not cut at the 2-minute default.
- Sharper deferred detection (scope qualifiers like "for this slice", and the seed-gated-on-out-of-scope cross-check), gate-cascade re-routing, and an ask before closing a map that still holds deferred work.

### Docs
- README: what a map is vs a single work, the `idea` / `seed` / `todo` spectrum, and a team-collaboration overview under "Why trailhead exists".
- Attribution and inline references to external systems moved out of the source and kept in the README only.

## 0.1.0

Initial release: the decision map plus the discuss/plan/execute/verify engine, all on GitHub Issues, distributed as a Claude Code plugin and an npm installer.
