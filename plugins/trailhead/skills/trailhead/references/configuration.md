# Configuration — keys and guided setup

Effective config = built-in defaults ← global `~/.claude/trailhead/config.json` ← the map's `## Config` block (project wins, key by key). The two layers and precedence are summarised in SKILL.md; this file holds the keys and the guided setup.

| Key | Values (default **bold**) | Effect |
|---|---|---|
| `models.{plan,execute,research,review,debug}` | a model id (**inherit session**) | model for that activity — see note |
| `design` | **`disk`** \| `claude.ai/design` | mode for UI mockups (**Prototype**). In `claude.ai/design` mode the concrete project is created/reused at execution and its URL cached in `design.project` |
| `design.approval` | **`explicit`** \| `auto` | must a mockup be explicitly approved before the build proceeds to UI code? |
| `tdd` | **`seams`** \| `on` \| `off` | how the `build` engine tests |
| `acceptance.browser` | **`auto`** \| `on` \| `off` | how **Acceptance testing** runs |
| `testing.webapp` / `testing.url` | bool / url | is it browser-drivable, and where |
| `plan_review` | **`off`** \| `on` \| CLI list (`gemini,codex`) | send `build` PLANs to external AI CLIs for review (**Cross-AI plan review**) |
| `plan_review.rounds` | integer (**`2`**) | max converge-and-re-review rounds |

**Models.** Overrides apply to **every subagent trailhead spawns** (`research`, codebase-map, code review) — passed as the subagent's model. The interactive `build` loop runs on the session's own model; when `models.plan` differs from `models.execute`, run the **Plan** step as a *planner subagent* on `models.plan`, then execute in the session on `models.execute`. If a value is unset, inherit the session model (never hard-fail on an unknown id — warn and inherit). **Store a full model id** (e.g. `claude-opus-5`, `claude-fable-5`), never a bare family alias like `opus` — a family now spans several live versions, so an alias can't say which one.

**tdd.** `seams` (default) = TDD at critical seams only; `on` = TDD for all behaviour with a definable input→output; `off` = tests after, or none for throwaway. The `build` engine's Plan/Execute honour this.

**acceptance.browser.** `auto` (default) = drive the browser when `testing.webapp` + `testing.url` are set, else fall back to a guided UAT checklist; `on` = always attempt browser-driving; `off` = always hand the human a UAT checklist. The Verify step honours this.

**design.approval.** `explicit` (default) = a UI mockup must be **explicitly approved by the user** before the `build` engine writes any real UI code — surface the mockup and wait for a clear go-ahead. `auto` = surface the mockup and proceed without blocking on a confirmation (the user can still object). The Prototype technique honours this.

**plan_review.** `off` (default) = build PLANs are not externally reviewed; `on` = review with every external AI CLI detected on the PATH; a comma list (`gemini,codex`) = only those. Needs the named CLIs installed; if none are available it's skipped, never failed. The `build` engine's Plan step runs **Cross-AI plan review** when this is on.

Example global `~/.claude/trailhead/config.json`:
```json
{ "models": { "plan": "opus", "execute": "sonnet" }, "tdd": "seams", "acceptance": { "browser": "auto" } }
```

## Guided setup

`/trailhead config` (no args) runs an **interactive walkthrough** — never make the user hand-edit JSON. Present each step as an `AskUserQuestion` menu with **icon-labelled options** and the current value pre-selected; write the answers to the chosen scope at the end and show a summary.

1. **Scope** — 🌍 Global default · 📁 This project (the map's `## Config`). Skip to global when there's no map.
2. **🧠 Models** — pick for **plan** and **execute**. Offer **inherit session** (the default) plus the session's own model and the concrete models it can reach — **always by full id**, because bare family names are now ambiguous (a family spans several live versions, e.g. Opus 4.8 *and* Opus 5). Never store `opus`/`sonnet`/`haiku` alone. Present the current lineup as options: the Opus family (`claude-opus-5`, `claude-opus-4-8`), `claude-sonnet-5`, `claude-haiku-4-5`, and `claude-fable-5` (Anthropic's most capable) — this list ages, so verify it against the models actually available at setup time rather than trusting it verbatim. The rarer `research`/`review`/`debug` sit behind an "Advanced" option.
3. **🎨 Design** — 💾 Local disk · 🖼️ claude.ai/design. *Mode only — don't ask for a URL here; the concrete project is created or reused at execution time (see Prototype).* Then **✅ Mockup approval** — 🖐️ Explicit (wait for a go-ahead before UI code) · ⏩ Auto (proceed without blocking).
4. **🧪 TDD** — 🎯 Seams only · ✅ On (all definable behaviour) · ⛔ Off.
5. **🌐 Acceptance testing** — 🤖 Auto · ▶️ Always browser · 🙋 Guided UAT only. If browser is enabled, ask **🔗 base URL** and confirm it's a web app.
6. **🧑‍⚖️ Plan review** — ⛔ Off · 🤝 All detected CLIs · 🎯 Pick specific (from the CLIs found on PATH). If on, ask **🔁 rounds** (default 2).

Keep the icons stable so the menus read the same each run. `config get` shows the same fields as a compact icon summary, read-only.
