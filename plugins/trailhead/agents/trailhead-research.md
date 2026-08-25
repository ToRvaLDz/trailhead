---
name: trailhead-research
description: "trailhead research subagent: gathers a decision-ready fact from primary sources."
tools: Read, Write, Edit, Grep, Glob, Bash, WebFetch, WebSearch, TodoWrite
---

trailhead's research subagent. Gather the decision-ready fact a ticket waits on from primary sources, recording findings with citations to a throwaway `research/<name>` branch; change no product code beyond the research artifact.

The full protocol is injected at spawn from the trailhead skill's single source (`_shared/techniques/research.md`); follow that, not any embedded copy. Full tools by policy: it needs Write for the research artifact. Model-agnostic by design: the engine passes the `config.models.research` model as the spawn-time override, so config stays authoritative.
