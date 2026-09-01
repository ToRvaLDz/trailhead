# Framing a forced choice

When trailhead must put a **forced choice** to the human (any `AskUserQuestion`-style prompt it authors, or an options list in prose), it presents the real options and the host's built-in escape ("Other" / "Chat about this"). On top of those, two standardised agent-assisted options are available, each offered only where it fits. This is a **standing convention**, not a `config` toggle: it is always available at the call-sites below. (If the prompts ever prove intrusive, a future `config` key could gate them; not built today.)

**Host constraint.** These options exist only inside questions **trailhead itself authors**. The host `AskUserQuestion` tool is not ours to change; we add the options as extra choices in the prompts we build.

## The one-line test: whose choice is it?

Before offering the delegate option, ask: **is the answer itself a project decision (a `decision`-ticket's answer, or a change to the map's destination or scope), as opposed to a process choice that merely gets folded into some ticket's ordinary resolution summary?**

- **Yes, it is a project decision, so the human owns it.** Do NOT offer the delegate option (the agent must never both frame the options and pick a decision that shapes the destination; see the decision engine's "the choice stays theirs"). You may still offer **defer** if the choice is genuinely blocked on something not yet resolved.
- **No, it is an advisory / process choice** (how the engine does its work, not what the project decides, even though the step it belongs to may later be summarised in a resolution comment). Offer the **delegate** option.

The distinction is "is this answer itself a project decision" versus "does this answer just happen to end up mentioned when a ticket resolves": every ticket's Resolve updates `Decisions so far`, so *being mentioned there* is not the test; *being a decision that shapes the work* is.

Positive (delegate offered): config values and the `/trailhead config` menus, model/tooling picks, the effort skip offer, cross-AI plan-review convergence, "which fix approach" at a verify checkpoint, a prototype-or-not ask, a badge style, a lychee flag, a branch/worktree mechanism.

Negative (delegate NOT offered): `decision`-ticket convergence, a scope or destination change, an out-of-scope ruling, routing a deferred line to seed/idea/todo, whether to close an exhausted map, a claim collision. These are the human's to make (or already are a routing the human owns).

## Option 1: "Let the agent pick (with rationale, then confirm)"

The delegate option. It does not let the agent silently decide: it is a **two-step, confirm-gated** interaction.

1. The human selects the delegate option.
2. The agent states **which option it would choose and why it beats the others** (concise, honest, the real trade-off), then asks a plain **yes/no confirmation**.
   - **Yes** → act on the chosen option.
   - **No, a counter-proposal, a "let's chat", or silence** → the choice **re-opens** (back to the menu / discussion). Never proceed on anything but an explicit yes. The human may counter-propose (the agent adopts it and re-confirms) or defer at this point.

This is **distinct from marking one option `(Recommended)`**, a static hint the agent may still use in the prompt: the recommendation pre-labels an option; the delegate option hands the pick to the agent under a confirm gate. Both may appear in the same prompt.

## Option 2: "Defer this decision"

For a choice whose best answer depends on something **not yet resolved**. It never means "the agent decides later on its own": it routes the choice into trailhead's existing dependency machinery so it resurfaces at the right time.

- **Depends on another not-yet-made map decision** → open a `decision` ticket for it and wire it `blocked_by` that prerequisite (the blocker three-move in `substrate.md`), labelled `trailhead:blocked`. It graduates onto the frontier when the prerequisite closes.
- **Depends on a future external trigger** (not a map decision) → capture a `seed` (`trailhead:seed`, kept blocked) gated on that trigger.
- **No substrate to route into** (a `/trailhead config` menu, or a map-less choice with no real dependency) → **defer is not offered**; make the choice now (delegate or chat). Defer is offered only when there is a genuine dependency to wait on.

When the deferred choice was blocking **this** ticket's own progress (e.g. a `build` ticket that stopped mid-Discuss on the ambiguity), also wire the ticket that raised it `## Blocked by` the new `decision` ticket, or pause it per `teamwork.md`, so it leaves the frontier until the prerequisite resolves. That ticket cannot finish this session; hand off per the session ritual.

## How to inject them (the recipe)

This is the operational recipe every applicable call-site follows. It is **mandatory, not optional**: where the table below marks an affordance applicable, it is **offered**, never merely "available". Applicability is set by the one-line test above and the table (delegate on advisory / process choices; defer only when there is a genuine dependency to wait on).

**Fixed labels.** Author the affordances with these canonical labels, rendered in the user's **conversation language** (they appear in the live prompt, not on the Issue, so this is the one place the ticket-language rule does not apply):
- Delegate -> "Let the agent pick (with rationale, then confirm)" (IT: "Lascia scegliere all'agente (con motivazione, poi conferma)", short "scegli tu").
- Defer -> "Defer this decision" (IT: "Rimanda questa decisione", short "scelgo dopo").

**Menu call-sites (an `AskUserQuestion` trailhead authors): the cap rule.** The host tool accepts only 2-4 real options (plus its own auto escape), so the affordances can be crowded out. The rule is deterministic: **fill up to the cap, then fall back to prose.**
- If **(real options + applicable affordances) <= 4**, add each applicable affordance as an explicit extra option in the same menu.
- If they **would exceed 4**, keep the real options in the menu and offer the affordance(s) that did not fit in **one line of prose immediately after the menu** (or as an immediate follow-up question). The cap never silently swallows them.

Worked examples: 2 real options + delegate + defer = 4 -> all in the menu; 3 real options + delegate + defer = 5 -> the menu carries the 3 real options and delegate/defer are offered in the prose line right after it; 2 real options + delegate (defer not applicable) = 3 -> in the menu.

**Prose / conversational call-sites (grilling, or any choice put in words rather than a menu).** There is no cap: **state the applicable affordance(s) in words** in the same message that puts the choice (for example append "Oppure: scegli tu, propongo io / scelgo dopo se dipende da un prerequisito."). Grilling stays human-decides, so delegate is not offered there; **defer is offered in prose when the decision is genuinely blocked on a prerequisite.**

`(Recommended)` on a real option is a separate, static hint that may coexist with the affordances; it is not the delegate option.

## Where each applies (call-site table)

| Call-site | Delegate | Defer |
|---|---|---|
| `decision` ticket converge (grilling) | No (human decides) | Yes, if blocked on a prerequisite |
| `build`/`quick` Discuss "stop and ask" | Yes | Yes |
| Effort skip offer (consolidated) | Yes | No (now-or-never process choice) |
| `/trailhead config` menus | Yes | No (no substrate) |
| Cross-AI plan-review convergence | Yes | Sometimes (a concern blocked on a prerequisite) |
| Verify checkpoint (which fix / how to proceed) | Yes for the advisory sub-choice; accept/resolve stays the human's | No |
| Prototype "want mockups?" | Yes | No |
| Teamwork split shape / submodule split | Yes (the shape is advisory) | No |
| Claim collision, isolation-mode suggestion | No (coordination stop) | No |
| Exhaustion "close the map?" | No (record the human owns) | No |
| Out-of-scope routing (deferred line → seed/idea/todo) | No (routing the human owns) | This IS a defer already |

The one-line test above generalises to any call-site not listed: if the answer is itself a project decision (a `decision`-ticket answer, or a destination/scope change) there is no delegate; a process choice that merely gets mentioned in a later resolution comment is still advisory.

**Compatibility with "the choice stays the human's."** The delegate option is compatible *because of* the confirm gate (the agent proposes, the human ratifies) and because it is withheld on destination-shaping decisions. Defer never hands a decision to the agent; it parks it on the substrate for a real decision later.
