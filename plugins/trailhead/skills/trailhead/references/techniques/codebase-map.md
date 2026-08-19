# Codebase map (fan-out)
One-time at project adoption. Fan out 5 read-only reader subagents in parallel (single message), each owning ONE non-overlapping facet — no facet reads another's territory:
- **Architecture** — pattern, layers, data flow, entry points, module seams; where the deep modules live.
- **Stack & dependencies** — languages, runtime, frameworks, manifests, build/config, external integrations (DBs, APIs, auth, webhooks).
- **Decisions already embodied / conventions** — style, naming, error handling, the repo's documented standards; patterns a new change must match.
- **Risk & complexity hotspots** — tech debt, fragile/God files, security-sensitive paths, TODO/FIXME clusters, expensive-to-change areas.
- **Test & build setup** — framework, test layout, mocking style, how to run tests/build/lint, coverage posture.

Give each agent read-only tools only (Read/Grep/Glob — never Edit/Write), a tight facet brief, and instruction to cite concrete file paths in backticks and return a compact summary (~10–20 lines), NOT file dumps. Keep facets disjoint so contexts don't collide; while they run, wait for all five. Then **distil** — don't concatenate — into ONE compact write-up (a few lines per facet, load-bearing paths preserved) and post it as the body of the repo's **`trailhead:codebase` issue** — a single per-repo issue (label `trailhead:codebase`), created if absent, updated if present. It is **not** in any map's Notes: it's repo-scoped, so every map of the repo links it and a finished map never strands it (each map's Notes carries just a link). The raw per-facet output is throwaway scratch: mine it, discard it. Do NOT persist per-facet reports as project state, do NOT re-run per ticket or per map — refresh the issue only on major drift.

