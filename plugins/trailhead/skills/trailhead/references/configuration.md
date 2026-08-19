# Configuration — keys and guided setup

Effective config = built-in defaults ← global `~/.claude/trailhead/config.json` ← project `.trailhead/config.json` at the repo root (project wins, key by key). **Config never lives in the map issue** — it's a plain file the user owns and changes at will. The layers and precedence are summarised in SKILL.md; this file holds the keys and the guided setup.

| Key | Values (default **bold**) | Effect |
|---|---|---|
| `models.{plan,execute,research,review,debug}` | a model id (**inherit session**) | model for that activity — see note |
| `ticket.language` | an ISO 639-1 code (**`en`**) | the language trailhead **writes** its GitHub prose in — ticket titles/bodies, engine comments, map body & commit descriptions — see note. Independent of the language the agent converses in |
| `design` | **`disk`** \| `claude.ai/design` | mode for UI mockups (**Prototype**). In `claude.ai/design` mode the concrete project is created/reused at execution and its URL cached in `design.project` |
| `design.approval` | **`explicit`** \| `auto` | must a mockup be explicitly approved before the build proceeds to UI code? |
| `tdd` | **`seams`** \| `on` \| `off` | how the `build` engine tests |
| `acceptance.browser` | **`auto`** \| `on` \| `off` | how **Acceptance testing** runs |
| `testing.webapp` / `testing.url` | bool / url | is it browser-drivable, and where |
| `plan_review` | **`off`** \| `on` \| CLI list (`gemini,codex`) | send `build` PLANs to external AI CLIs for review (**Cross-AI plan review**) |
| `plan_review.rounds` | integer (**`2`**) | max converge-and-re-review rounds |

**Models.** Overrides apply to **every subagent trailhead spawns** (`research`, codebase-map, code review) — passed as the subagent's model. The interactive `build` loop runs on the session's own model; when `models.plan` differs from `models.execute`, run the **Plan** step as a *planner subagent* on `models.plan`, then execute in the session on `models.execute`. If a value is unset, inherit the session model (never hard-fail on an unknown id — warn and inherit). **Store a full model id** (e.g. `claude-opus-5`, `claude-fable-5`), never a bare family alias like `opus` — a family now spans several live versions, so an alias can't say which one. **`models.plan` and `models.execute` are always distinct choices** — never collapse them into one shared model pick, even when the user would pick the same id for both.

**Ticket language.** `ticket.language` (ISO 639-1, default `en`) sets the language trailhead **writes** in on the Issues: ticket titles and bodies, engine comments (DISCUSS/PLAN/VERIFY/OPTIONS/REPRO/DIAGNOSIS/PAUSED/resolution), the map body sections, and commit message **descriptions**. It's fully decoupled from the language the agent *converses* in (its session/global setting) — setting `ticket.language` never changes how the agent talks to the user. **Untouched by it:** code and identifiers, the fixed `trailhead:*` label names, config keys/values, and the conventional-commit type prefix (`feat:`/`fix:` stay English). The skill's own source docs (SKILL.md, `references/`) are not project prose and stay English.

**tdd.** `seams` (default) = TDD at critical seams only; `on` = TDD for all behaviour with a definable input→output; `off` = tests after, or none for throwaway. The `build` engine's Plan/Execute honour this.

**acceptance.browser.** `auto` (default) = drive the browser when `testing.webapp` + `testing.url` are set, else fall back to a guided UAT checklist; `on` = always attempt browser-driving; `off` = always hand the human a UAT checklist. The Verify step honours this.

**design.approval.** `explicit` (default) = a UI mockup must be **explicitly approved by the user** before the `build` engine writes any real UI code — surface the mockup and wait for a clear go-ahead. `auto` = surface the mockup and proceed without blocking on a confirmation (the user can still object). The Prototype technique honours this.

**plan_review.** `off` (default) = build PLANs are not externally reviewed; `on` = review with every external AI CLI detected on the PATH; a comma list (`gemini,codex`) = only those. Needs the named CLIs installed; if none are available it's skipped, never failed. The `build` engine's Plan step runs **Cross-AI plan review** when this is on.

Example `config.json` (same shape for the project `.trailhead/config.json` and the global `~/.claude/trailhead/config.json`):
```json
{ "models": { "plan": "claude-opus-4-8", "execute": "claude-sonnet-5" }, "tdd": "seams", "acceptance": { "browser": "auto" } }
```

## Guided setup

`/trailhead config` (no args) runs an **interactive walkthrough** — never make the user hand-edit JSON. Present each step as an `AskUserQuestion` menu with **icon-labelled options** and the current value pre-selected; write the answers to the chosen scope at the end and show a summary.

1. **Scope** — 🌍 Global default (`~/.claude/trailhead/config.json`) · 📁 This project (`.trailhead/config.json` at the repo root). Skip to global outside a repo.
2. **🌐 Ticket language** — the language trailhead writes its GitHub prose & commit descriptions in (`ticket.language`, ISO 639-1). Offer 🇬🇧 English (`en`, default) · 🇮🇹 Italiano (`it`) · 🇪🇸 Español (`es`) · 🇫🇷 Français (`fr`) · 🇩🇪 Deutsch (`de`) · 🇵🇹 Português (`pt`), plus a free-code option for any other ISO 639-1 code. Note in the prompt that this is *not* the language the agent converses in.
3. **🧠 Models** — **always two separate questions, one for `plan` and one for `execute`; never merge them into a single model pick.** Ask each as its own `AskUserQuestion` menu (current value pre-selected), and offer the **same versioned lineup** to both. Each option is a **full model id with its version** — never a bare family alias (`opus`/`sonnet`/`haiku`), which can't say *which* live version. Build the list from the models actually reachable **at setup time** (verify, don't trust this file verbatim), offering **at least the two most recent versions per family**, e.g. `claude-fable-5`, `claude-opus-5` / `claude-opus-4-8`, `claude-sonnet-5` / `claude-sonnet-4-8`, `claude-haiku-4-5` — plus **inherit session** (the default). If that lineup exceeds the menu's option cap, drill **family → version** or include a free-id "Other" so every recent version stays reachable. The rarer `research`/`review`/`debug` sit behind an "Advanced" option — each its own separate choice, same versioned rule.
   - **Anti-pattern — never do this:** a single screen whose options are *combined* plan+execute presets, e.g. `🧠 Plan 4.8 / Exec Sonnet 5`, `🚀 Tutto Opus 5`, `Plan Opus 5 / Exec Sonnet 5`. That bundles the two decisions into one pick — forbidden. Plan is asked, answered, and only then is Execute asked, as a second menu. Two questions, two answers, always.
4. **🎨 Design** — 💾 Local disk · 🖼️ claude.ai/design. *Mode only — don't ask for a URL here; the concrete project is created or reused at execution time (see Prototype).* Then **✅ Mockup approval** — 🖐️ Explicit (wait for a go-ahead before UI code) · ⏩ Auto (proceed without blocking).
5. **🧪 TDD** — 🎯 Seams only · ✅ On (all definable behaviour) · ⛔ Off.
6. **🖥️ Acceptance testing** — 🤖 Auto · ▶️ Always browser · 🙋 Guided UAT only. If browser is enabled, ask **🔗 base URL** and confirm it's a web app.
7. **🧑‍⚖️ Plan review** — ⛔ Off · 🤝 All detected CLIs · 🎯 Pick specific (from the CLIs found on PATH). If on, ask **🔁 rounds** (default 2).

Keep the icons stable so the menus read the same each run. `config get` shows the same fields as a compact icon summary, read-only.
