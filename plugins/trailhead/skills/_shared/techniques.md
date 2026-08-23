## Techniques

The ticket engines call these by name. Each technique's full protocol lives in its own file under `techniques/`: **read that file the first time a session needs the technique**, so only the ones in play load into context (don't preload them). They are `trailhead`'s own, self-contained; subagents are spawned with the built-in `Agent` tool.

**Pin the subagent type; never borrow a foreign agent.** Every technique subagent carries its full protocol in the prompt (from its `techniques/` file), so it needs no specialised agent, and must not use one: **always set `subagent_type` to a built-in agent, never a project- or plugin-provided type** (a specialised `*-reviewer`, `*-researcher`, `*-mapper`, or similarly named agent that another installed tool registered). Even when such an agent's name or description matches the task perfectly, it follows *its own* protocol and artifact conventions (a specialised code-review agent writes its own review file, not trailhead's `VERIFY` ticket comment), so selecting it silently swaps trailhead's engine for another tool's. The split by what the technique touches: **read-only techniques** (Code review, Codebase map, and the Plan step) spawn **`Explore`** (reads, searches, runs tests; no Edit/Write); **repo-modifying techniques** (Research, Execute, Fix, Debug) spawn **`general-purpose`**. On a `subagentToolkit == none` host there is no fan-out and this is moot: every technique runs inline in the one session. (Codex is **not** such a host: it has the native multi_agent toolkit, so techniques fan out there too; see the Codex adapter's §D.)

| Technique | File | In one line |
|---|---|---|
| **Grilling** | `techniques/grilling.md` | interrogate the human, one question at a time, to converge on a decision |
| **Domain vocabulary** | `techniques/domain-vocabulary.md` | build a precise shared glossary so each term means one thing |
| **Prototype** | `techniques/prototype.md` | throwaway artifact for "how should it look/behave"; routes UI mockups (disk / claude.ai/design / stitch) |
| **Research** | `techniques/research.md` | a focused subagent gathers a decision-ready fact from primary sources |
| **TDD** | `techniques/tdd.md` | RED → GREEN → REFACTOR at the seams; no implementation before a failing test |
| **Codebase map** | `techniques/codebase-map.md` | one-time fan-out of 5 read-only readers, distilled into the repo's `trailhead:codebase` issue |
| **Debug** | `techniques/debug.md` | scientific method: reproduce → localise → falsifiable hypotheses → confirm cause → verify |
| **Code review** | `techniques/code-review.md` | review the diff on 4 axes, adversarially verify each finding before reporting |
| **Acceptance testing** | `techniques/acceptance-testing.md` | prove it does what the *user* wanted: automated → browser-drive → guided UAT |
| **Cross-AI plan review** | `techniques/plan-review.md` | send a PLAN to external AI CLIs, converge on their concerns (opt-in via `config.plan_review`) |
