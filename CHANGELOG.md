# Changelog

All notable changes to trailhead are recorded here. This project follows [Semantic Versioning](https://semver.org).

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
