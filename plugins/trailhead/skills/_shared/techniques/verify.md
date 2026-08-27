# Goal-backward verification

Prove the change **delivers what the ticket promised**, not merely that steps ran or the tests pass. This is distinct from **Code review** (which hunts bugs and quality issues adversarially) and from **Acceptance testing** (which proves it does what the *user* wanted, interactively): this is a **goal-backward** reasoning check against the ticket's own stated intent.

Run it in the `build`/`bug` **Verify** step, after the tests / the plan's criterion have run, as a subagent on `config.models.verify` (dispatch the **`trailhead-verify`** agent, read-only, passing `config.models.verify` as the model override; inline when the model is unset or equals the session model, and inline on a `subagentToolkit == none` host). Like the other reviews it **never blocks the session**: run it in the background and collect it by polling (see *Reviews never block the session* in `../techniques.md`).

1. **Restate the goal.** From the ticket's `## Question` and the `PLAN`'s verification criteria, list what "done" means as concrete, checkable claims. If the ticket named acceptance criteria, those are the claims.
2. **Work backward from each claim to the diff.** For every claim, find the commit(s) and lines that satisfy it, or record it as **unmet**. Read the actual diff and the resulting code, not the commit messages.
3. **Check for silent gaps.** A task marked done whose criterion no code satisfies; a criterion the tests do not actually exercise; a partial implementation that passes the tests but misses an edge the ticket called out.
4. **Verdict.** Post the result with a leading `status:` tag the engine branches on: `status: met` (every claim satisfied) or `status: gaps_found` (list each unmet or partial claim with its evidence). On `gaps_found` the engine loops back to Execute/Fix for the gap, or runs the HITL checkpoint, before Resolve; it never resolves over an unmet goal silently.

Adversarial posture: do not defer to a `CLAUDE.md` convention, a "settled decision" memory, or the executor's own claim that it is done. The diff and the ticket's stated goal are the only authorities.
