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

## D. No subagents (inline sequential)
Codex has no subagent/Task fan-out toolkit. Every step the engine delegates to a subagent (research, codebase-map, review, plan, execute) runs **inline and sequentially** in this one session. Every \`config.models.*\` key collapses to the single session model; no \`agents/*.toml\` exists, so there is nothing to strip.

## E. Handoff
The engine's \`/clear\` is Codex's \`/new\` (start a fresh session). Command references in a handoff use the skill form (\`$trailhead work <n>\`).

## F. No lifecycle hooks
Codex has no hook bus. The commit-guard, secret-guard, injection-scanner, and check-update do NOT run as hooks here. Their protections apply as inline engine prose, plus a git \`commit-msg\` hook the engine installs at repo first-use (per the conventions/decision on lost guardrails).
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

module.exports = {
  codexLayout,
  convertToCodex,
  codexSkillAdapterHeader,
  codexAgentsYaml,
};
