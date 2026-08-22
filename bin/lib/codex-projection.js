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
    // pre-#25 layout, swept on install/uninstall for clean migration
    legacyPromptsDir: path.join(codexHome, 'prompts'),
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
trailhead is a native Codex skill. Invoke it as \`$trailhead <verb>\` (e.g. \`$trailhead work\`, \`$trailhead new "idea"\`); bare \`$trailhead\` is smart entry. Never \`/trailhead:<verb>\` (that is the Claude Code surface). Whatever you type after the verb is the arguments.

## B. This IS the skill
Codex loaded this SKILL.md because you invoked \`$trailhead\`; there is no separate Skill tool to call. When the engine says to load a \`references/*.md\` file, Read it from this skill directory (\`~/.codex/skills/trailhead/\`).

## C. AskUserQuestion -> request_user_input
Where the engine uses \`AskUserQuestion\`, use Codex's \`request_user_input\`: map \`header\`->\`header\`, \`question\`->\`question\`, each option \`{label, description}\`; generate an \`id\` from the header (lowercase, spaces->underscores). Codex has no \`multiSelect\`: present sequential single-selects, or a numbered freeform list and ask for comma-separated numbers. If \`request_user_input\` is unavailable, present the choices as a plain-text numbered list and STOP for the user's reply; do not silently pick a default and proceed.

## D. Subagents (native multi_agent)
Codex has a subagent toolkit: the multi_agent tools (\`spawn_agent\`, \`send_input\`, \`wait_agent\`, \`resume_agent\`, \`close_agent\`), stable and on by default on supported Codex (the installer gates on the floor that guarantees them). Where the engine delegates to a subagent (research, codebase-map, review, plan, execute, debug), spawn a real Codex subagent with these tools and the technique's own protocol (each technique carries its full protocol in-prompt, so no specialised agent is needed; pass the ticket's \`Scope:\` when relevant). The Claude-only Explore-vs-general-purpose split does not apply: Codex has one subagent kind. A subagent runs as a FRESH session that receives a task prompt, not this conversation; run independent ones in parallel (e.g. the codebase-map readers) and \`wait_agent\` on them.

\`config.models.*\` still cannot take effect here: those are Claude model ids and Codex's subagent model registry is OpenAI-only, so subagents inherit the one session model regardless. The one-time models-collapse notice still applies. No \`agents/*.toml\` is projected: base multi_agent needs no manifest, and per-subagent model pinning (which would need OpenAI ids + \`multi_agent_v2\`) is deferred.

## E. Handoff
The engine's \`/clear\` is Codex's \`/new\` (start a fresh session). Command references in a handoff use the skill form (\`$trailhead work <n>\`).

## F. Lifecycle hooks (native Codex hooks)
Codex has a hook bus, so trailhead's guardrails run as **real Codex hooks**, not degraded prose. The installer registers them in \`~/.codex/hooks.json\`: commit-guard and secret-guard as \`PreToolUse\` (matcher \`Bash\`) hooks that can veto the command before it runs, the injection-scanner as a \`PostToolUse\` (matcher \`Bash\`) advisory, and check-update as a \`SessionStart\` hook. They use the same wire format they use on Claude Code (JSON on stdin, a \`decision\`/\`permissionDecision\` verdict on stdout), which Codex accepts. The host-independent git \`commit-msg\` hook is still installed at repo first-use as well (defence in depth), exactly as on Claude. Codex gates hooks behind \`features.hooks = true\` and reviews them for trust on first start: the installer enables the flag, and Codex will ask you to trust trailhead's hooks the next time it starts.
</codex_skill_adapter>`;
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

// --- CODEX_AGENT_TECHNIQUES ------------------------------------------------
// Metadata for the 5 trailhead activities that can get a per-technique Codex
// custom-agent TOML: a short UI description and the developer_instructions
// that steer that subagent on Codex, pointing back at the projected skill.
const CODEX_AGENT_TECHNIQUES = Object.freeze({
  plan: Object.freeze({
    description: "trailhead planning subagent: produces a build ticket's PLAN (steps, seams, files, verification)",
    developerInstructions: "You are trailhead's planning subagent on Codex. Produce the PLAN for a trailhead build ticket: the steps, the seams, the files touched, and the verification criteria, applying TDD per the ticket's config. Follow the Plan step and the referenced technique in the trailhead skill at ~/.codex/skills/trailhead. Return the plan; do not implement.",
  }),
  execute: Object.freeze({
    description: 'trailhead execute subagent: implements a PLAN with atomic commits',
    developerInstructions: "You are trailhead's execute subagent on Codex. Implement the approved PLAN for a trailhead build ticket with atomic conventional commits, each carrying a Refs: #<n> trailer for the ticket, following the repo's conventions. Follow the Execute step in the trailhead skill at ~/.codex/skills/trailhead.",
  }),
  research: Object.freeze({
    description: 'trailhead research subagent: gathers a decision-ready fact from primary sources',
    developerInstructions: "You are trailhead's research subagent on Codex. Gather the decision-ready fact a ticket waits on from primary sources, per the Research technique in the trailhead skill at ~/.codex/skills/trailhead. Record findings with citations; change no product code beyond the research artifact.",
  }),
  review: Object.freeze({
    description: "trailhead code-review subagent: adversarially reviews a ticket's diff",
    developerInstructions: "You are trailhead's code-review subagent on Codex. Review the ticket's diff adversarially on the trailhead Code review technique's axes, verifying each finding before reporting, per the trailhead skill at ~/.codex/skills/trailhead. Do not defer to a convention or a settled-decision memory.",
  }),
  debug: Object.freeze({
    description: "trailhead debug subagent: finds a defect's root cause by the scientific method",
    developerInstructions: "You are trailhead's debug subagent on Codex. Find the root cause of the ticket's defect by the scientific method (reproduce, localise, falsifiable hypotheses, confirm, verify), per the Debug technique in the trailhead skill at ~/.codex/skills/trailhead.",
  }),
});

// --- codexAgentToml ---------------------------------------------------------
// Render one Codex custom-agent TOML. model_reasoning_effort is emitted only
// when effort is a non-empty string. developer_instructions is a TOML
// multi-line literal block ('''...'''); a stray ''' inside the text (none of
// ours has one, but be safe) is neutralised so it can't close the block early.
function codexAgentToml({ name, description, developerInstructions, model, effort }) {
  const safeInstructions = String(developerInstructions).split("'''").join("''");
  const lines = [
    `name = "${name}"`,
    `description = "${description}"`,
    `model = "${model}"`,
  ];
  if (typeof effort === 'string' && effort.trim() !== '') {
    lines.push(`model_reasoning_effort = "${effort}"`);
  }
  lines.push(`developer_instructions = '''\n${safeInstructions}\n'''`);
  return lines.join('\n') + '\n';
}

// --- codexAgentTomlPlan ------------------------------------------------------
// Given the resolved models.codex config (a plain object like
// { plan: "gpt-5.6-terra", execute: { model: "gpt-5.6-sol", effort: "high" } },
// or null/undefined/{}), return the set of trailhead-<technique>.toml writes
// the installer should make. Skips unknown keys and empty values. Iterates
// CODEX_AGENT_TECHNIQUES in declaration order (not the config's key order) so
// the write order is deterministic regardless of how the config was authored.
function codexAgentTomlPlan(codexHome, codexModels) {
  const models = codexModels && typeof codexModels === 'object' ? codexModels : {};
  const dir = codexLayout(codexHome).codexAgentsDir;
  const writes = [];

  for (const technique of Object.keys(CODEX_AGENT_TECHNIQUES)) {
    const raw = models[technique];
    if (raw == null) continue;

    let model = null;
    let effort = null;
    if (typeof raw === 'string') {
      if (raw.trim() !== '') model = raw;
    } else if (typeof raw === 'object') {
      const m = typeof raw.model === 'string' ? raw.model : '';
      if (m.trim() !== '') {
        model = m;
        effort = typeof raw.effort === 'string' ? raw.effort : null;
      }
    }
    if (!model) continue;

    const meta = CODEX_AGENT_TECHNIQUES[technique];
    const name = `trailhead-${technique}`;
    const filePath = path.join(dir, `${name}.toml`);
    const content = codexAgentToml({
      name,
      description: meta.description,
      developerInstructions: meta.developerInstructions,
      model,
      effort,
    });
    writes.push({ technique, name, path: filePath, content });
  }

  return { writes };
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
  codexAgentsYaml,
  codexAgentToml,
  codexAgentTomlPlan,
  codexHookEntries,
  enableCodexFeatureFlag,
  enableCodexHooksFeature,
  enableCodexMultiAgentV2Feature,
};
