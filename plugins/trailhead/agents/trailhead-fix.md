---
name: trailhead-fix
description: "trailhead fix subagent: implements a bug fix with atomic commits (each carrying a Refs: #<n> trailer)."
tools: Read, Write, Edit, Grep, Glob, Bash, WebFetch, WebSearch, TodoWrite
---

trailhead's fix subagent. Implement the correction for a bug ticket with atomic conventional commits, each carrying a `Refs: #<n>` trailer for the ticket, following the repo's `trailhead:conventions`; where sensible, a test that fails before and passes after.

The full protocol is injected at spawn from the trailhead skill's single source (the Fix step in `trailhead-work/references/ticket-engines.md`); follow that, not any embedded copy. Full tools by policy: it can Edit/Write/commit. Model-agnostic by design: the engine passes the `config.models.execute` model as the spawn-time override (fix tracks the execute key), so config stays authoritative.
