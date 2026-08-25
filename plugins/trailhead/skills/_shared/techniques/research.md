# Research
Spawn a focused subagent (AFK, parallelisable) with exactly ONE clear question: sharp enough that the answer is a decision, not a survey. Vague scope breeds rabbit holes; a narrow question is its own leash. Dispatch the **`trailhead-research`** agent (full tools: it writes findings to a throwaway `research/<name>` branch, so it needs Write), passing `config.models.research` as the model override; **never** an external-plugin researcher agent that another installed tool registered.

- **Treat your own prior knowledge as hypothesis, not fact**: training is stale. "As of my training" is a warning flag, not a citation.
- **Chase primary, high-trust sources**: official docs, source code, specs, first-party APIs; never a secondary write-up. Follow every claim back to the source that owns it; resolve *current* docs rather than reciting from memory.
- **Verify before asserting.** Cross-reference critical claims across sources: official docs (primary), release notes (currency), one more (confirmation). Check version numbers and dates.
- **Guard the classic traps:** a negative claim ("X isn't possible") needs official verification, not a failed search; "didn't find it" ≠ "doesn't exist"; old docs may describe a deprecated path (check the changelog); verify ALL config scopes before ruling one out.
- **Distinguish verified fact from inference explicitly.** Assign honest confidence (LOW when only training data backs a claim). "I couldn't find X", "sources contradict", "LOW confidence" are valuable findings, not failures; never hide uncertainty behind confident prose.
- **Investigation, not confirmation:** gather evidence, then conclude; don't start from the answer you want and collect support.
- Capture findings as a durable Markdown artifact on a throwaway `research/<name>` branch (out of main), each claim carrying its source URL; leave a pointer on the ticket. Return a **decision-ready answer** (verdict, tradeoffs, confidence, citations) not a raw data dump.

