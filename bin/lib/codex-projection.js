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

// --- enableCodexHooksFeature ----------------------------------------------
// Codex gates the hook bus behind `features.hooks = true` in config.toml. Given
// the current config.toml text (or '' when absent), return the updated text that
// enables it, or `null` when it is already enabled, or `{ unsafe: true }` when the
// file can't be edited safely (the caller then prints a manual instruction rather
// than risk corrupting the user's config). Conservative and idempotent: it only
// appends a fresh table, inserts the single key into an existing [features]
// table, or flips an explicit `hooks = false`; anything ambiguous is left alone.
function enableCodexHooksFeature(tomlText) {
  const text = typeof tomlText === 'string' ? tomlText : '';
  // Dotted top-level form: features.hooks = <x>
  if (/^\s*features\.hooks\s*=\s*true\s*(#.*)?$/m.test(text)) return null;
  if (/^\s*features\.hooks\s*=/m.test(text)) return { unsafe: true }; // set to something we won't touch
  const featHeader = /^[ \t]*\[features\][ \t]*(#.*)?$/m;
  const m = featHeader.exec(text);
  if (m) {
    const bodyStart = m.index + m[0].length;
    const rest = text.slice(bodyStart);
    const nextRel = rest.search(/^[ \t]*\[[^\]]+\][ \t]*(#.*)?$/m);
    const bodyEnd = nextRel === -1 ? text.length : bodyStart + nextRel;
    const body = text.slice(bodyStart, bodyEnd);
    if (/^\s*hooks\s*=\s*true\s*(#.*)?$/m.test(body)) return null;
    if (/^\s*hooks\s*=\s*false\s*(#.*)?$/m.test(body)) {
      const newBody = body.replace(/^([ \t]*hooks[ \t]*=[ \t]*)false([ \t]*(#.*)?)$/m, '$1true$2');
      return text.slice(0, bodyStart) + newBody + text.slice(bodyEnd);
    }
    if (/^\s*hooks\s*=/m.test(body)) return { unsafe: true };
    return text.slice(0, bodyStart) + '\nhooks = true' + text.slice(bodyStart);
  }
  // No [features] table at all: append one.
  const prefix = text.length === 0 ? '' : (text.endsWith('\n') ? '' : '\n');
  const gap = text.length === 0 ? '' : '\n';
  return text + prefix + gap + '[features]\nhooks = true\n';
}

module.exports = {
  codexLayout,
  convertToCodex,
  codexSkillAdapterHeader,
  codexAgentsYaml,
  codexHookEntries,
  enableCodexHooksFeature,
};
