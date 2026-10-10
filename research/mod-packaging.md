# Research: can the core plugin ship a mod alongside its command hooks? (#199, map #198)

Date: 2026-10-10. Host build under test: Claude Code 2.1.296 (docs/types bundled with 2.1.293).
Older builds tested from the npm platform packages `@anthropic-ai/claude-code-linux-x64@{2.1.150, 2.1.200, 2.1.270, 2.1.285}`.
All experiments used throwaway plugins under the session scratchpad (`exp-a`, `exp-b`, `exp-c`, `exp-d`) and, for install tests, an isolated `CLAUDE_CONFIG_DIR` (the real `~/.claude` was not touched).

## Verdict

**"Inside the core plugin" holds for the Claude Code plugin/marketplace channel, with one correction: it does NOT hold by itself for the npm installer channel.**

- One `hooks/hooks.json` can hold both `hooks` (command hooks) and `modules` (the mod). Works, verified.
- A build that cannot or will not load the module (old build, rollout flag off) skips only the module, logs one debug line, and keeps the plugin and its command hooks working. Verified on 2.1.150, 2.1.200, 2.1.270, 2.1.285.
- The npm installer (`bin/trailhead.js`) does not install a plugin at all: it copies hook scripts to `~/.claude/hooks` and writes entries into `settings.json`. It never reads `plugins/trailhead/hooks/hooks.json`. A `modules` entry there is invisible to that channel. To ship the mod through npm the installer must place a small mod plugin dir under `<configDir>/skills/<name>/` (verified to load as `<name>@skills-dir`).

## Working manifest shape (verified)

`plugins/trailhead/.claude-plugin/plugin.json`: unchanged (`"hooks": "./hooks/hooks.json"` stays; the loader logs it "names the standard hooks/hooks.json, which loads on its own; loaded once", benign).

`plugins/trailhead/hooks/hooks.json`:

```json
{
  "hooks": { "PreToolUse": [ ...existing command hooks... ] },
  "modules": ["./mod/register.ts"]
}
```

Rules (all verified by `claude plugin validate`):
- `modules` is an ARRAY with exactly one path, relative to `hooks.json` itself (`hooks/mod/register.ts` here). A string fails: `modules: Invalid input: expected array, received string`. A path relative to the plugin root fails: `no such file`. A second entry fails: ``hooks.json `modules` names one hooks module per plugin; a second entry is refused``.
- The file must export `register(on, options)`; `.ts/.tsx/.js/...` are loaded directly.
- `hooks` and `modules` may be both present; the schema refine says "must have `hooks` ... or `modules` ..., or both".

Experiment `exp-a`: copy of `plugins/trailhead` with `modules: ["./mod/register.ts"]` and a 5-line `session.start` hook:

```
$ claude plugin validate exp-a/trailhead
  ❯ ./mod/register.ts hooks: session.start
  ❯ ./mod/register.ts calls: $.ui.log
✔ Validation passed
$ claude -p --plugin-dir exp-a/trailhead --debug-file dbg-a.log "say ok"
dbg-a.log: hooks module trailhead@inline loaded (worker, environment 1, tier user); events: session.start
dbg-a.log: Hooks: SessionStart:startup [node ".../exp-a/trailhead/hooks/trailhead-check-update.js"] (plugin trailhead@inline) finished with status 0
```

Module and a real command hook of the trailhead plugin both ran in the same session.

## Sub-point answers

### 1. One file, both entries? Yes (confidence: high)

Evidence: the run above; reference doc "hooks/hooks.json ... Can also hold settings hooks under `hooks`" (https://code.claude.com/docs/en/plugins/mods/reference#files); schema text in the 2.1.296 binary: `.refine((e)=>e.hooks!==void 0||(e.modules?.length??0)>0, {message:"hooks.json must have `hooks` ... or `modules` ..., or both"})`. No separate manifest field is needed (`plugin.json` needs nothing).

### 2. Build without mods / mods off (confidence: high for old/flag-off/policy; medium for untrusted workspace)

Verified experimentally, plugin `exp-b` = `hooks` (UserPromptSubmit command hook that touches a marker file) + `modules`, loaded with `--plugin-dir`, run headless:

| build | module loaded | command hook ran | what it said |
|---|---|---|---|
| 2.1.296 | yes | yes | `hooks module exp-b@inline loaded` |
| 2.1.285 | no | yes | debug: `hooks module exp-b@inline not loaded: hooks modules are not turned on for installed plugins in this process (early access: set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 ...)`; stderr (for `--plugin-dir` + `-p` only): `exp-b: hooks module not loaded: ...` |
| 2.1.270 | no | yes | debug: `hooks modules not loaded: rollout flag (tengu_plugin_hooks_modules) is off, from GrowthBook` |
| 2.1.200 | n/a (no module loader) | yes | `plugin validate` passes; unknown `modules` key silently ignored |
| 2.1.150 | n/a | yes | same |

So an old or flag-off build: ignore the module, never fail the plugin, command hooks run. On 2.1.150/2.1.200 the log shows `Duplicate hooks file detected: ./hooks/hooks.json` as `[ERROR]` because plugin.json names the standard path; the command hook still ran (marker file created). That is pre-existing and independent of `modules`.

Documented off-switches (https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off, .../troubleshoot#refusal-messages, .../admin): `disableAllHooks`, `allowManagedHooksOnly`, `--bare`, `--safe-mode`, org `allowManagedModsOnly`, remote rollout switch. The refusal text is `hooks module <name> not loaded: <reason>` in the debug log (stderr for `-p --plugin-dir`). Docs state `disableAllHooks` (user settings) and `allowManagedModsOnly` "stop a mod and leave the rest of its plugin in place: skills, commands, agents, and MCP servers load" and for `allowManagedModsOnly`, "Users' settings hooks ... and in plugins' `hooks/hooks.json` ... aren't affected". Note `disableAllHooks` also stops the plugin's own command hooks (it disables hooks, not just mods): that is the user's intent there.

Not tested: an untrusted workspace (docs: "In an interactive session in a directory the user hasn't trusted yet, no mod loads until they answer the trust prompt"). Not tested: a managed-settings policy (no admin access).

### 3. Minimum version; runtime detection (confidence: medium-high)

- Docs: mods on by default in terminal v2.1.287+, Desktop v2.1.286+ (overview, "Turn mods on or off"; `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored from 2.1.287). Web search of a secondary source dates the "Added Claude Mods" changelog entry to 2.1.287 (1 Oct 2026); the changelog itself was not opened.
- Observed: the loader code exists already in 2.1.270 and 2.1.285 but was gated by a server-side GrowthBook flag `tengu_plugin_hooks_modules` (served off for those builds in my runs) or the env var. So "2.1.287" is the first build where it is on by default for everyone; before that it can be off with no user recourse.
- Types: individual events/methods have their own minimums (e.g. `tool.check` `e.agentId` needs 2.1.290, `prompt.mention` 2.1.290, `.catch` `re-entry` 2.1.292, per reference.md). State "Claude Code 2.1.287 or later" for the feature and the exact build tested (2.1.296) for the API.
- Runtime: `$.session.version()` returns `{ version, base?, builtAt? }` (types d.ts ~L2816-2833, L11688-11712). It only runs inside a module that already loaded, so it cannot detect "mods are off" (that case never runs your code); it is useful to gate use of newer events/methods inside a module on a mod-enabled build. A loaded module is itself the proof that mods are on. Untested: what a mod-enabled but older build does with a hook on an event it does not know (docs say `plugin validate` reports `"x" is not an event` as an error, so run validate against the oldest supported build).

### 4. npm installer and Codex projection (confidence: high from reading code; install path verified)

Read `bin/trailhead.js` (`installClaude` ~L384-460, `copyHookScripts` ~L268-298, `claudePaths` ~L238-245):
- Claude npm channel: skills are placed under `<configDir>/skills/<name>`, commands under `commands/trailhead`, hook scripts by allowlist (`HOOK_FILES`, `HOOK_LIB_FILES`) into `<configDir>/hooks`, agents into `<configDir>/agents`; hooks are registered with `addHook(settings...)` into `settings.json`. `plugins/trailhead/hooks/hooks.json` and `plugin.json` are never read. => the module is NOT delivered by the npm channel today.
- Fix (verified in experiment `exp-d`): a plugin folder at `<configDir>/skills/<name>/` with `.claude-plugin/plugin.json` + `hooks/hooks.json` (`modules`) + the `.ts` file is auto-loaded: `hooks module exp-d@skills-dir loaded (worker, ..., tier user)`, and its command hook also ran. So the installer should `place()` a dedicated mod plugin dir (e.g. `skills/trailhead-mod`, modules-only hooks.json, own plugin.json) and add its name to the sweep/uninstall/`install-verify` lists, exactly like `HOOK_FILES`. Caveat: `sweepTrailheadSkills` and `engineSkillDirs()` scan `plugins/trailhead/skills`, so keep the mod dir outside that tree (for example `plugins/trailhead/mod/`) and give the npm copy its own name. Admin note: org allowlists need `skills-dir` for this load path (admin doc, "A marketplace allowlist" row).
- Double load: a user with both the plugin and the npm copy would get two mods (`trailhead@<mkt>` and `trailhead-mod@skills-dir`). Untested; same class of issue as the existing doubled command hooks. Decide a dedupe (guard on a `$.store` key or `$.plugin.name`) in the design.
- No build step: `register.ts` ran directly (docs: "You don't need Node.js, a bundler, or a build step, because Claude Code loads `.js` and `.ts` files directly"; verified in all runs above). `.ts`, `.tsx`, `.jsx`, `.js`, `.mjs`, `.cjs`, `.mts`, `.cts` load; any other extension is not loaded; the module and every imported file must be inside the plugin dir, relative `import` only (no `import()`, bare import only `claude-code`).
- npm package `files` ships `plugins/` whole, so `.ts` sources go out as-is. But `copyHookScripts` copies by allowlist, never recursively, so a `.ts` under `plugins/trailhead/hooks/` never reaches `~/.claude/hooks` or Codex.
- Codex projection (`bin/lib/codex-projection.js`, `installCodex` in trailhead.js ~L560-730): builds `~/.codex/hooks.json` from `codexHookEntries(...)` and copies hook scripts by name (`CODEX_HOOK_EXCLUDE`); it never reads the plugin's `hooks.json`. So a `modules` entry is skipped with no code change, as long as the mod files are not added to the Codex copy lists. If a test pins "everything under plugins/trailhead/hooks", re-check (`bin/lib/codex-projection.test.js`).
- The `types/` the engine writes into the mod dir (`.claude-plugin/types/`) are generated at load for `--plugin-dir`/skills-dir folders the person owns; do not commit them (not needed to run).

### 5. Consent and off switch for an installed mod (confidence: high for no prompt; medium-high for toggles)

- No hot-reload consent prompt applies. The "Enable for this session" hot-reload question is only for mods Claude writes into the session mods folder (`~/.claude/dev-mods/<session>`) (create doc, "Approve the mod"). Verified: a plugin installed from a (local) marketplace into an isolated config dir loaded its module at startup in a headless run with no question: `hooks module exp-c@exp-mkt loaded (worker, ..., tier user)`; the plugin's command hook ran too. Install is the consent; docs: "install mods only from authors and marketplaces you trust" and an interactive workspace-trust prompt still precedes any load.
- After `claude plugin install` from a shell while a session is open, `/reload-plugins` is needed (overview); otherwise next start.
- Off switches for a user:
  - disable/uninstall the plugin in `/plugin` Installed tab: stops the mod AND the command hooks (whole plugin);
  - `disableAllHooks: true` in `~/.claude/settings.json`: all installed mods and all hooks;
  - `--safe-mode` for one session; org `allowManagedModsOnly`;
  - mod-only toggle: not provided by the platform per plugin. Do it with a `userConfig` boolean in `plugin.json` that `register(on, options)` reads (docs: `options` = `userConfig` values with defaults; settings key `pluginConfigs["<plugin>@<marketplace>"].options`; non-secret fields appear as rows in the config menu and a change reloads the module). Verified: a `userConfig` boolean `enableMod` validates and `plugin install` prompts "1 userConfig option not yet set"; the reading side (`options.enableMod === false` -> return early) is documented in the types (d.ts ~L7585-7600) but I did not run it. For the skills-dir (npm) copy the key would be `trailhead-mod@skills-dir` (inferred from the `<name>@inline` / `<name>@skills-dir` ids, untested).

## Risks and open items

1. npm channel parity: needs installer + uninstall + `install-verify` work (new placed dir); otherwise only marketplace users get the mod. This is the main correction to the ticket's premise.
2. The remote rollout flag can turn installed mods off for everyone ("Anthropic has turned installed mods off remotely" in troubleshoot). The module must be an enhancement, never a dependency of correctness; command hooks remain the guard of record. Verified that this degrades silently (debug log only for installed plugins).
3. Single module per plugin; one entry in `modules`; so the core plugin gets exactly one mod file (it can import others inside the plugin).
4. The API is "early access and moves between releases" (reference.md L3): pin the tested build in the README and run `claude plugin validate` and `claude plugin test` in CI against it.
5. Mods are not sandboxed; `claude plugin validate` lists `hooks:`/`calls:`/`gating hook` lines which can be shown at install for reviewability. Trailhead adding code that runs in-process with user permissions raises the trust bar versus pure command hooks; say so in the README.
6. Org allowlists: marketplace installs follow `strictKnownMarketplaces`; the skills-dir path needs `skills-dir` allowed.
7. Untested: untrusted-workspace behaviour, managed-settings policies, double load (plugin + npm), `options` toggle at runtime, a mod-enabled build older than the API used.

## Sources

- Bundled authoring docs: `/tmp/claude-1000/bundled-skills/2.1.293/d6c85dfa46393aaf482536e91403ed92/plugin-authoring/reference.md` (L9-14 hooks module shape, L66-72 `--plugin-dir`/folders/installed plugin, L74-77 skipped hook/module reporting, L79-101 sharing) and `.../types/claude-code.d.ts` (`Register` L9244; `PluginOptions`/userConfig ~L7585; `session.version` ~L2816, L11688).
- Official docs fetched 2026-10-10: https://code.claude.com/docs/en/plugins/mods/overview, .../create, .../reference, .../troubleshoot, .../admin.
- Binary 2.1.296 strings (schema and loader messages): `hooks.json must have hooks ... or both`; `names one hooks module per plugin`; `installed plugins' hooks modules not loaded: rollout flag (tengu_plugin_hooks_modules) is off`; `hooks modules are turned off here (disableAllHooks, allowManagedHooksOnly or a policy)`.
- Repo: `bin/trailhead.js` (L238-245, L268-298, L384-460), `bin/lib/codex-projection.js`, `plugins/trailhead/.claude-plugin/plugin.json`, `plugins/trailhead/hooks/hooks.json`, `package.json` `files`.
