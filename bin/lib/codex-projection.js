'use strict';
// codex-projection.js: pure host-native artifact projection for Codex CLI.
//
// trailhead ships one engine, written for Claude Code. This module is the
// single place that knows how to turn that Claude-native prose into
// Codex-native artifacts: the native-skill layout Codex expects things
// placed at (skills/trailhead/), the deterministic text rewrites that swap
// Claude's command surface/paths for Codex's, the adapter header prepended
// to the projected SKILL.md, and the agents/openai.yaml UI metadata that
// registers the skill for explicit-only invocation (`$trailhead <verb>`).
//
// Pure module: no fs/process access here. The installer (bin/trailhead.js)
// does all the I/O and calls into these functions.

const path = require('path');

// --- codexLayout --------------------------------------------------------
// Absolute paths for every artifact this module projects, rooted at a given
// Codex config dir (normally $CODEX_HOME or ~/.codex, resolved upstream by
// host-descriptor's configDirFor).
function codexLayout(codexHome) {
  const skillsRoot = path.join(codexHome, 'skills');
  const skillDir = path.join(skillsRoot, 'trailhead');
  return {
    skillsRoot,
    skillDir,
    skillMain: path.join(skillDir, 'SKILL.md'),
    referencesDir: path.join(skillDir, 'references'),
    agentsDir: path.join(skillDir, 'agents'),
    agentsYaml: path.join(skillDir, 'agents', 'openai.yaml'),
    // The REAL Codex custom-agent dir, rooted at the codex HOME (distinct
    // from the skill-local agentsDir/agentsYaml above, which hold the
    // openai.yaml UI metadata). This is where trailhead-<technique>.toml
    // model pins land so Codex's native multi_agent_v2 registry finds them.
    codexAgentsDir: path.join(codexHome, 'agents'),
    templatesDir: path.join(skillDir, 'templates'),
    versionFile: path.join(skillDir, 'VERSION'),
    hooksScriptsDir: path.join(skillDir, 'hooks'),
    hooksJson: path.join(codexHome, 'hooks.json'),
    configToml: path.join(codexHome, 'config.toml'),
    // Active Codex prompts dir: holds the #41 discoverability shims
    // (trailhead.md smart entry + one trailhead-<verb>.md per verb). The
    // install/uninstall sweep also migrates the pre-#25 layout out of it.
    promptsDir: path.join(codexHome, 'prompts'),
    legacyEngineDir: path.join(codexHome, 'trailhead'),
  };
}

// --- convertToCodex ------------------------------------------------------
// Deterministic text rewrites, Claude-native markdown in, Codex-native
// markdown out. Order matters: the anchored path forms must run before the
// bare form (`.claude/`), and the command-surface rewrite is slash-anchored
// so bare GitHub labels like `trailhead:build` (no leading slash) never get
// touched, only the `/trailhead:<verb>` / `/trailhead` command surface does.
function convertToCodex(md) {
  let out = md;

  // 1. Command surface: /trailhead:<verb> -> $trailhead <verb>; bare
  // /trailhead -> $trailhead. Slash-anchored so bare labels like
  // `trailhead:build` (no leading slash) survive. The colon rule MUST run
  // before the bare rule. The bare rule uses a negative lookahead, NOT \b:
  // \b treats the boundary before `/` and `-` as a word edge, so `\b` would
  // wrongly eat `/trailhead` inside PATH segments (`skills/trailhead/...`,
  // `templates/trailhead-commit-msg`). Excluding `/`, `-`, `:` and word
  // chars converts only the standalone `/trailhead` command, never a path.
  out = out.replace(/\/trailhead:/g, '$trailhead ');
  out = out.replace(/\/trailhead(?![\w:/-])/g, '$trailhead');

  // 2. Claude's /clear -> Codex's /new.
  out = out.replace(/\/clear\b/g, '/new');

  // 3. Paths: anchored forms first, then the bare form.
  out = out.replace(/\$HOME\/\.claude\b/g, '$HOME/.codex');
  out = out.replace(/~\/\.claude\b/g, '~/.codex');
  out = out.replace(/(?<![A-Za-z0-9_\-.\/~$])\.claude\//g, '.codex/');

  // 4. Plugin root -> the installed skill dir.
  out = out.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '~/.codex/skills/trailhead');

  return out;
}

// --- codexSkillAdapterHeader ---------------------------------------------
// Prepended (plus a blank line) to the converted SKILL.md so a Codex session
// reading the engine gets the host-mapping rules before the engine body.
function codexSkillAdapterHeader() {
  return `<codex_skill_adapter>
This trailhead engine is running on **Codex CLI**, not Claude Code. The installer projected it here; apply these host mappings as you follow the engine below.

## A. Commands
trailhead is a native Codex skill. Invoke it as \`$trailhead <verb>\` (e.g. \`$trailhead work\`, \`$trailhead new "idea"\`); bare \`$trailhead\` is smart entry. Never \`/trailhead:<verb>\` (that is the Claude Code surface). Whatever you type after the verb is the arguments. For discoverability the installer also projects one thin skill per verb (\`$trailhead-work\`, \`$trailhead-bug\`, …) that just delegates to \`$trailhead <verb>\`, so the verbs surface in the \`$\`-menu; \`$trailhead <verb>\` stays the canonical form and this SKILL.md the single source of truth. (Codex custom prompts under \`~/.codex/prompts/\` are deliberately NOT used: they do not surface as slash commands.)

## B. This IS the skill; the engine is split across sibling skill dirs
Codex loaded this SKILL.md because you invoked \`$trailhead\` (or a \`$trailhead-<verb>\` / \`$trailhead-<cluster>\` entry); there is no separate Skill tool to call. The engine is split across sibling skill dirs under \`~/.codex/skills/\`: the dispatcher (\`trailhead/\`), five cluster skills (\`trailhead-chart/\`, \`trailhead-work/\`, \`trailhead-view/\`, \`trailhead-capture/\`, \`trailhead-manage/\`), and the shared core (\`_shared/\`, no SKILL.md). Read every referenced file **relative to the SKILL.md you are currently in**: a \`references/*.md\` from this skill's own dir, and the shared core (\`../_shared/*.md\`, or \`../../_shared/*.md\` from a \`references/\` file) from the sibling \`_shared/\` dir. Where the dispatcher's routing says "call the Skill tool with skill name \`trailhead-<cluster>\` and arguments \`<verb> <rest>\`", there is no Skill tool on Codex: **Read \`../trailhead-<cluster>/SKILL.md\` (the sibling dir) and follow it**, treating \`<verb> <rest>\` as its arguments.

## C. AskUserQuestion -> request_user_input
Where the engine uses \`AskUserQuestion\`, use Codex's \`request_user_input\`: map \`header\`->\`header\`, \`question\`->\`question\`, each option \`{label, description}\`; generate an \`id\` from the header (lowercase, spaces->underscores). Codex has no \`multiSelect\`: present sequential single-selects, or a numbered freeform list and ask for comma-separated numbers. If \`request_user_input\` is unavailable, present the choices as a plain-text numbered list and STOP for the user's reply; do not silently pick a default and proceed.

## D. Subagents (native multi_agent)
Codex has a subagent toolkit: the multi_agent tools (\`spawn_agent\`, \`send_input\`, \`wait_agent\`, \`resume_agent\`, \`close_agent\`), stable and on by default on supported Codex (the installer gates on the floor that guarantees them). Where the engine delegates to a subagent (research, codebase-map, review, plan, execute, debug), spawn a real Codex subagent with these tools and the technique's own protocol (each technique carries its full protocol in-prompt, so no specialised agent is needed; pass the ticket's \`Scope:\` when relevant). The Claude-only Explore-vs-general-purpose split does not apply: Codex has one subagent kind. A subagent runs as a FRESH session that receives a task prompt, not this conversation; run independent ones in parallel (e.g. the codebase-map readers) and \`wait_agent\` on them.

**Never surrender the session to one open-ended \`wait_agent\`; poll instead.** \`wait_agent\` blocks until the subagent returns, so a single unconditional \`wait_agent\` on a long or stalling subagent freezes the whole session with nothing to check: this is the review / plan-review hang. Collect every delegated subagent through a **bounded wait in a poll loop**, not one open-ended blocking call. Give \`wait_agent\` a short timeout (30 to 60s); on each timeout, report a one-line "still running" progress note and loop again, so the session stays responsive and can be checked or interrupted between polls. The two **review** steps, **Code review** and **Cross-AI plan review**, always run this way: backgrounding and polling them (never a blind \`wait_agent\`) is the engine's hard cross-host default, not merely the case where it matters most. They are also the longest quiet activities in the cycle (a full-diff adversarial review, or an external CLI) and the ones most often seen to hang. If your Codex build's \`wait_agent\` exposes no timeout, poll the agent's status/output at intervals instead of blocking, or run the review as a **background job** and check back on it at intervals; the rule is the same either way. When several subagents run in parallel, poll them as a set, a bounded wait cycling across the outstanding handles, reporting which are still running.

**Per-technique agent registry (\`agent_type\` dispatch).** The installer always projects all 7 committed trailhead agents as \`~/.codex/agents/trailhead-<technique>.toml\` (one per technique) and enables \`features.multi_agent_v2\`, so Codex always exposes a per-technique agent registry. A TOML whose technique has a \`models.codex.<key>\` pin set carries that OpenAI model (plus its reasoning effort); every other TOML — an unpinned keyed technique, or one of the 2 keyless agents — is pin-less and its subagent inherits the session model. Detect the registry at runtime by introspecting the visible \`spawn_agent\` tool schema (GSD-style, never a config read): if its parameters expose an \`agent_type\` field, spawn each delegated activity as \`spawn_agent(agent_type="trailhead-<technique>", reasoning_effort=…)\` (\`trailhead-plan\` for the Plan step, \`trailhead-execute\` for Execute, likewise research/review/debug, plus the 2 keyless \`trailhead-fix\` and \`trailhead-codebase-map\` for the Fix and Codebase-map steps), which routes it onto that technique's pinned model when one is set, or the session model otherwise. If the \`spawn_agent\` schema exposes NO \`agent_type\` field at all (a Codex build with only base multi_agent v1), spawn with base \`spawn_agent\` and the subagents inherit the one session model. Trust the tool surface you actually see and degrade gracefully: \`multi_agent_v2\` is still under development upstream, so v1 stays a supported runtime.

\`config.models.*\` (Claude model ids) still cannot take effect here regardless: Codex's subagent model registry is OpenAI-only, so a Claude id cannot run and those keys collapse to the session model. The honoured namespace on Codex is \`models.codex.*\` (above); the one-time models-collapse notice still applies while a stray \`models.*\` is set and \`models.codex.*\` is empty.

## E. Handoff
The engine's \`/clear\` is Codex's \`/new\` (start a fresh session). Command references in a handoff use the skill form (\`$trailhead work <n>\`).

## F. Lifecycle hooks (native Codex hooks)
Codex has a hook bus, so trailhead's guardrails run as **real Codex hooks**, not degraded prose. The installer registers them in \`~/.codex/hooks.json\`: commit-guard and secret-guard as \`PreToolUse\` (matcher \`Bash\`) hooks that can veto the command before it runs, the injection-scanner as a \`PostToolUse\` (matcher \`Bash\`) advisory, and check-update as a \`SessionStart\` hook. They use the same wire format they use on Claude Code (JSON on stdin, a \`decision\`/\`permissionDecision\` verdict on stdout), which Codex accepts. The host-independent git \`commit-msg\` hook is still installed at repo first-use as well (defence in depth), exactly as on Claude. Codex gates hooks behind \`features.hooks = true\` and reviews them for trust on first start: the installer enables the flag, and Codex will ask you to trust trailhead's hooks the next time it starts.

## G. Design / UI mockups -> local disk
The \`claude.ai/design\` mockup mode (DesignSync: the \`claude_design\` MCP + the \`/design-sync\` skill) does not exist on Codex, so it **collapses to local-disk mockups** here: whatever \`config.design\` says, the Prototype technique's \`disk\` path is the only one available. Produce a throwaway static HTML mockup next to the code, link it from the ticket, and never attempt DesignSync / claude.ai/design on Codex (there is no \`claude_design\` MCP or \`/design-sync\` skill to call). \`config.design.approval\` still applies unchanged: \`explicit\` waits for the user's go-ahead before any UI code, \`auto\` surfaces the mockup and proceeds.

## H. Shell timeouts & background jobs (plan-review's external CLIs)
The **Cross-AI plan review** technique invokes each external reviewer CLI (\`codex exec\`, \`gemini -p\`, \`qwen -p\`, …) through Claude Code's **Bash tool**, and tells the engine to beat that tool's ~2-minute default cut by setting its \`timeout\` parameter to the 10-minute max, or launching the call with \`run_in_background: true\` and collecting it later. Those are Claude Bash-tool knobs with no Codex equivalent, so map the *intent* onto Codex's own shell/exec tool. Reviews never block the session (the engine's hard cross-host default), so **the default is to background the reviewers** and collect them by polling, never block on them: launch each with a trailing \`&\` (or your shell tool's background form), **redirect its stdin from \`/dev/null\` and its output to a file** (\`codex exec … "<prompt>" < /dev/null > out.txt 2>&1 &\`), and poll/collect when it finishes, so several reviewers run in parallel instead of serially eating the wall-clock; or wrap each reviewer invocation in a §D subagent so the long-running call sits behind the multi_agent poll loop. Where a reviewer must run synchronously instead, give that call its **own long timeout** (the \`timeout_ms\` / equivalent on Codex's shell/exec tool, set to several minutes, never the short default), so a reviewer that legitimately runs for minutes is not cut mid-review. Either way plan-review's own rule is unchanged: never rely on a short default timeout, retry once at the wide margin, then drop a still-slow reviewer rather than let it wedge the build. **Close the reviewer's stdin when backgrounding it** (\`< /dev/null\`): \`codex exec\` reads additional prompt input from stdin and blocks on EOF, so a backgrounded reviewer that inherits an open or attached stdin sits idle at "Reading additional input from stdin..." (0% CPU) forever instead of running (passing the prompt as an argument does not exempt it). Guard the poll loop too: a reviewer pinned at 0% CPU with no output past a threshold is stuck, so surface it and drop it after the one retry rather than reporting "still running" indefinitely. This is the external-CLI **shell** path; §D covers the separate **subagent** (\`wait_agent\`) path, and the two are distinct (an external reviewer CLI is a plain shell call, not a spawned Codex subagent).
</codex_skill_adapter>`;
}

// --- injectCodexAdapterHeader --------------------------------------------
// Insert the adapter header into an already-converted SKILL.md so it sits
// AFTER the YAML frontmatter, never above it. Codex registers a skill from the
// frontmatter (`name:` / `description:`) only when it is the very first bytes
// of SKILL.md; a header prepended above `---` pushes the frontmatter off the
// top and the skill never registers (#40). Splits the leading `---...---`
// block off and reassembles frontmatter + header + body. With no frontmatter
// present, falls back to a plain prepend (nothing to protect).
function injectCodexAdapterHeader(converted) {
  const header = codexSkillAdapterHeader();
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(converted);
  if (!m) return header + '\n\n' + converted;
  const frontmatter = m[0];
  const body = converted.slice(frontmatter.length);
  return frontmatter.replace(/\s+$/, '') + '\n\n' + header + '\n\n' + body.replace(/^\s+/, '');
}

// --- codexAgentsYaml -------------------------------------------------------
// UI metadata for the native-skill surface: display name, short description,
// a default prompt shown before invocation, and explicit-only invocation
// (no auto-trigger on unrelated turns).
function codexAgentsYaml() {
  return `interface:
  display_name: "Trailhead"
  short_description: "Chart & work a project as decision tickets"
  default_prompt: "Use $trailhead to chart a new map, or $trailhead work to take the next ticket."
policy:
  allow_implicit_invocation: false
`;
}

// --- codexClusterAgentsYaml ------------------------------------------------
// UI metadata for a projected cluster skill (trailhead-chart, trailhead-work,
// ...): a display name + explicit-only invocation, so a cluster never
// auto-loads into an unrelated turn. Mirrors codexAgentsYaml's shape.
function codexClusterAgentsYaml(cluster) {
  const short = String(cluster).replace(/^trailhead-/, '');
  return `interface:
  display_name: ${yamlQuote(`Trailhead: ${short}`)}
  short_description: ${yamlQuote(`trailhead ${short} cluster`)}
  default_prompt: ${yamlQuote(`Run $${cluster}`)}
policy:
  allow_implicit_invocation: false
`;
}

// --- CODEX_AGENT_NAME_ALIASES / codexTechniqueKey ---------------------------
// The 7 committed agent sources (plugins/trailhead/agents/trailhead-*.md) are
// keyed by their trailhead-<name>.md filename stem. Two of those stems don't
// match the models.codex.<key> pin namespace, so alias them; every other
// agent's key is just its name with the trailhead- prefix stripped.
const CODEX_AGENT_NAME_ALIASES = Object.freeze({
  'trailhead-executor': 'execute',
  'trailhead-code-review': 'review',
});

function codexTechniqueKey(name) {
  return CODEX_AGENT_NAME_ALIASES[name] || String(name).replace(/^trailhead-/, '');
}

// --- MODEL_KEYS --------------------------------------------------------------
// The 5 pinnable technique keys, mirroring the models.codex.* namespace. The
// other 2 committed agents (fix, codebase-map) have no pin key and are always
// projected pin-less (session model).
const MODEL_KEYS = new Set(['plan', 'execute', 'research', 'review', 'debug']);

// --- codexAgentToml ---------------------------------------------------------
// Render one Codex custom-agent TOML. When `model` is empty/absent, the TOML
// is pin-less: no `model =` line (and so no model_reasoning_effort either),
// so the subagent inherits the session model. When `model` is present,
// model_reasoning_effort is emitted only when effort is a non-empty string.
// developer_instructions is a TOML multi-line literal block ('''...'''); a
// stray ''' inside the text (none of ours has one, but be safe) is
// neutralised so it can't close the block early.
function codexAgentToml({ name, description, developerInstructions, model, effort }) {
  const safeInstructions = String(developerInstructions).split("'''").join("''");
  const lines = [
    `name = "${name}"`,
    `description = "${description}"`,
  ];
  if (typeof model === 'string' && model.trim() !== '') {
    lines.push(`model = "${model}"`);
    if (typeof effort === 'string' && effort.trim() !== '') {
      lines.push(`model_reasoning_effort = "${effort}"`);
    }
  }
  lines.push(`developer_instructions = '''\n${safeInstructions}\n'''`);
  return lines.join('\n') + '\n';
}

// --- codexAgentTomlPlan ------------------------------------------------------
// Given the resolved models.codex config (a plain object like
// { plan: "gpt-5.6-terra", execute: { model: "gpt-5.6-sol", effort: "high" } },
// or null/undefined/{}) and `agentDefs` (the array from the installer's
// readAgentDefs(): every committed plugins/trailhead/agents/trailhead-*.md,
// each { name, description, tools, body }), return the set of
// trailhead-<technique>.toml writes the installer should make: ONE per agent,
// uniformly (all 7 project, always). A keyed agent (plan/execute/research/
// review/debug) carries its models.codex.<key> pin when set, else is
// pin-less; the 2 keyless agents (fix, codebase-map) are always pin-less.
// Iterates agentDefs in the given order (readAgentDefs sorts by name) so the
// write order is deterministic.
function codexAgentTomlPlan(codexHome, codexModels, agentDefs) {
  const models = codexModels && typeof codexModels === 'object' ? codexModels : {};
  const dir = codexLayout(codexHome).codexAgentsDir;
  const defs = Array.isArray(agentDefs) ? agentDefs : [];
  const writes = [];

  for (const def of defs) {
    const key = codexTechniqueKey(def.name);
    const name = `trailhead-${key}`;
    const filePath = path.join(dir, `${name}.toml`);

    let model = null;
    let effort = null;
    if (MODEL_KEYS.has(key) && models[key] != null) {
      const raw = models[key];
      if (typeof raw === 'string') {
        if (raw.trim() !== '') model = raw;
      } else if (typeof raw === 'object') {
        const m = typeof raw.model === 'string' ? raw.model : '';
        if (m.trim() !== '') {
          model = m;
          effort = typeof raw.effort === 'string' ? raw.effort : null;
        }
      }
    }

    const lead = 'You are running on Codex CLI; the trailhead skill lives at ~/.codex/skills/trailhead.\n\n';
    const developerInstructions = lead + convertToCodex(String(def.body || '')).trim();

    const content = codexAgentToml({
      name,
      description: def.description,
      developerInstructions,
      model,
      effort,
    });
    writes.push({ technique: key, name, path: filePath, content });
  }

  return { writes };
}

// --- CODEX_SMART_ENTRY -----------------------------------------------------
// Discoverability metadata for the bare `/trailhead` smart-entry prompt (the
// one shim with no corresponding commands/*.md file).
// --- yamlQuote -------------------------------------------------------------
// Double-quote a scalar for a YAML frontmatter value, escaping the two chars
// that matter inside a double-quoted YAML string (backslash and double-quote).
function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// --- codexVerbSkillContent -------------------------------------------------
// One thin per-verb Codex SKILL.md: frontmatter (name + description, the two
// fields Codex registers a skill from, so they sit at byte 0) over a single
// delegating instruction to `$trailhead <verb>`. This is the GSD approach
// (each command projected as its own skill), because ~/.codex/prompts/ shims
// do not surface as slash commands on Codex (#46). No engine logic lives here;
// the canonical `$trailhead` skill stays the single source of truth.
function codexVerbSkillContent({ verb, description } = {}) {
  const v = String(verb == null ? '' : verb).trim();
  const desc = (description && String(description).trim())
    || `trailhead ${v}`;
  const fm = `---\nname: trailhead-${v}\ndescription: ${yamlQuote(desc)}\n---\n\n`;
  const body = `This is a thin discoverability entry for trailhead's **${v}** action on Codex. Run \`$trailhead ${v}\`, passing along whatever arguments you were given, and follow the \`$trailhead\` skill's instructions. The \`$trailhead\` skill is the single source of truth; do not re-implement its behaviour here.\n`;
  return fm + body;
}

// --- codexVerbSkillAgentsYaml ----------------------------------------------
// The per-verb skill's openai.yaml: UI metadata plus explicit-only invocation,
// so the 20-odd verb skills are invocable as `$trailhead-<verb>` but never
// auto-loaded into an unrelated turn's context (which would bloat it).
function codexVerbSkillAgentsYaml({ verb, description } = {}) {
  const v = String(verb == null ? '' : verb).trim();
  const desc = (description && String(description).trim()) || `trailhead ${v}`;
  const short = desc.length > 180 ? `${desc.slice(0, 177)}...` : desc;
  return `interface:
  display_name: ${yamlQuote(`Trailhead: ${v}`)}
  short_description: ${yamlQuote(short)}
  default_prompt: ${yamlQuote(`Run $trailhead-${v}`)}
policy:
  allow_implicit_invocation: false
`;
}

// --- codexVerbSkillPlan ----------------------------------------------------
// Given the resolved verb list (each { verb, description? }, or a bare string
// verb; normally read from plugins/trailhead/commands/*.md by the installer),
// return the per-verb skill writes: for each verb a skills/trailhead-<verb>/
// dir with SKILL.md + agents/openai.yaml. No bare-smart-entry skill is emitted:
// the canonical `$trailhead` skill already IS smart entry. Skips empty/invalid
// verbs. Mirrors codexAgentTomlPlan's shape. `dirs` lists every skill dir it
// writes into, for the installer's ensure()/sweep.
function codexVerbSkillPlan(codexHome, verbs) {
  const skillsRoot = codexLayout(codexHome).skillsRoot;
  const list = Array.isArray(verbs) ? verbs : [];
  const writes = [];
  const dirs = [];
  for (const entry of list) {
    const v = entry && typeof entry === 'object' ? entry.verb : entry;
    if (v == null || String(v).trim() === '') continue;
    const verb = String(v).trim();
    const description = entry && typeof entry === 'object' ? entry.description : undefined;
    const skillDir = path.join(skillsRoot, `trailhead-${verb}`);
    dirs.push(skillDir);
    writes.push({
      verb,
      path: path.join(skillDir, 'SKILL.md'),
      content: codexVerbSkillContent({ verb, description }),
    });
    writes.push({
      verb,
      path: path.join(skillDir, 'agents', 'openai.yaml'),
      content: codexVerbSkillAgentsYaml({ verb, description }),
    });
  }
  return { writes, dirs };
}

// --- codexHookEntries -----------------------------------------------------
// The four guardrail hooks trailhead registers on Codex, as {event, matcher,
// command} records. Commands run the copied guard scripts under hooksScriptsDir
// via node, matching Claude's `node "<path>"` form. PreToolUse guards (commit +
// secret) can veto; the injection-scanner is a PostToolUse advisory; check-update
// runs at SessionStart. Reused by the installer, which merges them into
// ~/.codex/hooks.json (same shape as Claude's settings.json hooks block).
function codexHookEntries(hooksScriptsDir) {
  const cmd = (name) => `node "${path.join(hooksScriptsDir, name)}"`;
  return [
    { event: 'PreToolUse', matcher: 'Bash', command: cmd('trailhead-commit-guard.js') },
    { event: 'PreToolUse', matcher: 'Bash', command: cmd('trailhead-secret-guard.js') },
    { event: 'PostToolUse', matcher: 'Bash', command: cmd('trailhead-issue-injection-scanner.js') },
    { event: 'SessionStart', matcher: '', command: cmd('trailhead-check-update.js') },
  ];
}

// --- enableCodexFeatureFlag -------------------------------------------------
// Codex gates a lifecycle feature behind `features.<flag> = true` in
// config.toml. Given the current config.toml text (or '' when absent) and the
// flag name, return the updated text that enables it, or `null` when it is
// already enabled, or `{ unsafe: true }` when the file can't be edited safely
// (the caller then prints a manual instruction rather than risk corrupting the
// user's config). Conservative and idempotent: it only appends a fresh table,
// inserts the single key into an existing [features] table, or flips an
// explicit `<flag> = false`; anything ambiguous is left alone.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function enableCodexFeatureFlag(tomlText, flag) {
  const text = typeof tomlText === 'string' ? tomlText : '';
  const flagRe = esc(flag);
  // Dotted top-level form: features.<flag> = <x>
  if (new RegExp(`^\\s*features\\.${flagRe}\\s*=\\s*true\\s*(#.*)?$`, 'm').test(text)) return null;
  if (new RegExp(`^\\s*features\\.${flagRe}\\s*=`, 'm').test(text)) return { unsafe: true }; // set to something we won't touch
  const featHeader = /^[ \t]*\[features\][ \t]*(#.*)?$/m;
  const m = featHeader.exec(text);
  if (m) {
    const bodyStart = m.index + m[0].length;
    const rest = text.slice(bodyStart);
    const nextRel = rest.search(/^[ \t]*\[[^\]]+\][ \t]*(#.*)?$/m);
    const bodyEnd = nextRel === -1 ? text.length : bodyStart + nextRel;
    const body = text.slice(bodyStart, bodyEnd);
    if (new RegExp(`^\\s*${flagRe}\\s*=\\s*true\\s*(#.*)?$`, 'm').test(body)) return null;
    if (new RegExp(`^\\s*${flagRe}\\s*=\\s*false\\s*(#.*)?$`, 'm').test(body)) {
      const newBody = body.replace(new RegExp(`^([ \\t]*${flagRe}[ \\t]*=[ \\t]*)false([ \\t]*(#.*)?)$`, 'm'), '$1true$2');
      return text.slice(0, bodyStart) + newBody + text.slice(bodyEnd);
    }
    if (new RegExp(`^\\s*${flagRe}\\s*=`, 'm').test(body)) return { unsafe: true };
    return text.slice(0, bodyStart) + `\n${flag} = true` + text.slice(bodyStart);
  }
  // No [features] table at all: append one.
  const prefix = text.length === 0 ? '' : (text.endsWith('\n') ? '' : '\n');
  const gap = text.length === 0 ? '' : '\n';
  return text + prefix + gap + `[features]\n${flag} = true\n`;
}

// --- enableCodexHooksFeature ----------------------------------------------
// Codex gates the hook bus behind `features.hooks = true` in config.toml.
function enableCodexHooksFeature(tomlText) {
  return enableCodexFeatureFlag(tomlText, 'hooks');
}

// --- enableCodexMultiAgentV2Feature -----------------------------------------
// Codex gates per-subagent model pinning (the agents/*.toml registry) behind
// `features.multi_agent_v2 = true` in config.toml.
function enableCodexMultiAgentV2Feature(tomlText) {
  return enableCodexFeatureFlag(tomlText, 'multi_agent_v2');
}

module.exports = {
  codexLayout,
  convertToCodex,
  codexSkillAdapterHeader,
  injectCodexAdapterHeader,
  codexAgentsYaml,
  codexClusterAgentsYaml,
  codexAgentToml,
  codexAgentTomlPlan,
  codexVerbSkillContent,
  codexVerbSkillAgentsYaml,
  codexVerbSkillPlan,
  codexHookEntries,
  enableCodexFeatureFlag,
  enableCodexHooksFeature,
  enableCodexMultiAgentV2Feature,
};
