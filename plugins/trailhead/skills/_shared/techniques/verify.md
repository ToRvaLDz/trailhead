# Goal-backward verification

Prove the change **delivers what the ticket promised**, not merely that steps ran or the tests pass. This is distinct from **Code review** (which hunts bugs and quality issues adversarially) and from **Acceptance testing** (which proves it does what the *user* wanted, interactively): this is a **goal-backward** reasoning check against the ticket's own stated intent.

Run it in the `build`/`bug` **Verify** step, after the tests / the plan's criterion have run, as a subagent on `config.models.verify` (dispatch the **`trailhead-verify`** agent, read-only, passing `config.models.verify` as the model override; inline when the model is unset or equals the session model, and inline on a `subagentToolkit == none` host). Like the other reviews it **never blocks the session**: run it in the background and collect it by polling (see *Reviews never block the session* in `../techniques.md`).

1. **Restate the goal.** From the ticket's `## Question` and the `PLAN`'s verification criteria, list what "done" means as concrete, checkable claims. If the ticket named acceptance criteria, those are the claims.
2. **Work backward from each claim to the diff.** For every claim, find the commit(s) and lines that satisfy it, record it as **unmet** if the code does not satisfy it, or as **inconclusive** (with a reason-class, see the Verdict) if you could not actually evaluate it: the check would not run, the evidence was unreadable, or the criterion is not falsifiable as written. Read the actual diff and the resulting code, not the commit messages.
3. **Check for silent gaps.** A task marked done whose criterion no code satisfies; a criterion the tests do not actually exercise; a partial implementation that passes the tests but misses an edge the ticket called out. A claim you **could not evaluate at all** is not a gap: it is `inconclusive` (step 4), never forced to `gaps_found`.
4. **Verdict.** Post the result with a leading `status:` tag the engine branches on, one of three:
   - `status: met`: every claim was evaluated and satisfied.
   - `status: gaps_found`: at least one claim was **evaluated and the code does not satisfy it** (list each unmet or partial claim with its evidence).
   - `status: inconclusive`: at least one claim **could not be evaluated at all**, and none is an outright gap. Every inconclusive claim carries **exactly one** mandatory `reason:` from this closed set:

   | reason | meaning |
   |---|---|
   | `unrunnable-check` | the verification command is not runnable (tool / dependency / environment missing) |
   | `unreadable-evidence` | diff / file / output not readable or truncated |
   | `untestable-criterion` | the PLAN criterion is not falsifiable as written |

   **Golden rule:** a claim that was **not evaluated** never becomes `met` nor `gaps_found`; it becomes `inconclusive`. `gaps_found` keeps its exact meaning, "evaluated, and the code does not satisfy the claim", and never absorbs a check that simply could not run.

   **Mixed states.** With claims falling in more than one class, emit **one** leading `status:` tag by precedence **`gaps_found` > `inconclusive` > `met`**, and in the body list every claim with its own class (and its one `reason:` where inconclusive). The engine clears the gaps first, autonomously (the Execute/Fix loop, AFK-friendly); the `inconclusive` claims resurface on re-verify and escalate to the human only when nothing else remains, so the cycle always converges.

   **Routing.** On `gaps_found` the engine loops back to Execute/Fix for the gap, or runs the HITL checkpoint, before Resolve; it never resolves over an unmet goal silently. When the **leading** tag is `inconclusive` (every gap already cleared, so no `gaps_found` outranks it), the goal is **unevaluated, not satisfied**: it is a **blocking gate too** and is never auto-resolved over. (While `gaps_found` still leads, the Fix loop runs first per Mixed states above; the inconclusive claims only reach this checkpoint once no gap remains.) Because nothing changes between runs of a read-only check, there is **no auto-retry**; go straight to the HITL checkpoint, framed per reason-class (reusing the shared checkpoint mechanics in `code-review.md`: name each surviving blocker, put the choice to the user, never auto-advance):
   - `unrunnable-check` / `unreadable-evidence`: name the failed command / unreadable file, then offer (i) fix the environment and re-verify, or (ii) resolve accepting the claim as unverified (recorded in the `VERIFY` comment, the annotate-in-`VERIFY` path code review uses).
   - `untestable-criterion`: state that the criterion is not falsifiable as written, then offer (i) reframe / replace the criterion (back to Plan for that claim), (ii) drop the criterion, or (iii) resolve accepting it unverified.

Adversarial posture: do not defer to a `CLAUDE.md` convention, a "settled decision" memory, or the executor's own claim that it is done. The diff and the ticket's stated goal are the only authorities.
