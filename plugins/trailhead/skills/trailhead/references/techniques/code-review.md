# Code review
Runs after execute, before closing a `build`/`bug` ticket — as a subagent when the diff is non-trivial, inline for a tiny change. Review the DIFF, not the whole tree: pin a fixed point (the ticket's base commit / branch point / merge-base) and scope to `git diff <base>...HEAD`. Confirm the ref resolves and the diff is non-empty first. Review on four axes:

- **Correctness** — real bugs: broken logic, unhandled errors, edge cases, race conditions, wrong data flow.
- **Security** — injection, secret leakage, auth/authz gaps, unvalidated boundary input.
- **Reuse & simplification** — duplicated shape to extract, primitive obsession, speculative generality, a shallow pass-through to delete or deepen, needless complexity.
- **Standards & spec** — does it match the repo's documented conventions AND do what the ticket actually asked (missing requirements, scope creep, plausibly-wrong implementations)? Suppress smells a documented standard endorses; skip anything tooling already enforces.

Classify each finding: **Critical** (bug/security/breaks the spec) → **Warning** (should fix) → **Info** (judgement call). Before reporting ANY finding, **verify it adversarially** — re-read the actual code, confirm the failing path is reachable and the claim holds. Discard plausible-but-wrong findings; an unverified finding is worse than none. Quote the offending hunk (and the standard/spec line) per finding. Report in the ticket's `VERIFY` comment, grouped by severity with file:line and the fix. Fix every Critical before resolving; leave Warnings/Info noted for the caller to weigh.

