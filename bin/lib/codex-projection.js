'use strict';
// codex-projection.js: pure host-native artifact projection for Codex CLI.
//
// trailhead ships one engine, written for Claude Code. This module is the
// single place that knows how to turn that Claude-native prose into
// Codex-native artifacts: the layout Codex expects things placed at, the
// deterministic text rewrites that swap Claude's command surface/paths for
// Codex's, the adapter header prepended to the projected SKILL.md, and the
// thin per-verb prompt files Codex reads instead of a Skill tool call.
//
// Pure module: no fs/process access here. The installer (bin/trailhead.js)
// does all the I/O and calls into these functions.

const path = require('path');

// --- codexLayout --------------------------------------------------------
// Absolute paths for every artifact this module projects, rooted at a given
// Codex config dir (normally $CODEX_HOME or ~/.codex, resolved upstream by
// host-descriptor's configDirFor).
function codexLayout(codexHome) {
  const trailheadDir = path.join(codexHome, 'trailhead');
  const skillDir = path.join(trailheadDir, 'skill');
  return {
    promptsDir: path.join(codexHome, 'prompts'),
    trailheadDir,
    skillDir,
    skillMain: path.join(skillDir, 'SKILL.md'),
    referencesDir: path.join(skillDir, 'references'),
    versionFile: path.join(trailheadDir, 'VERSION'),
    templatesDir: path.join(trailheadDir, 'templates'),
  };
}

// --- convertToCodex ------------------------------------------------------
// Deterministic text rewrites, Claude-native markdown in, Codex-native
// markdown out. Order matters: the anchored path forms must run before the
// bare form (`.claude/`), and the command-surface rewrite is slash-anchored
// so bare GitHub labels like `trailhead:build` (no leading slash) never get
// touched, only the `/trailhead:<verb>` command namespace does.
function convertToCodex(md) {
  let out = md;

  // 1. Command surface: /trailhead:<verb> -> /trailhead-<verb>. Slash-anchored
  // on purpose: labels like `trailhead:build` (no leading slash) must survive.
  out = out.replace(/\/trailhead:/g, '/trailhead-');

  // 2. Claude's /clear -> Codex's /new (fresh-session command).
  out = out.replace(/\/clear\b/g, '/new');

  // 3. Paths: anchored forms first, then the bare form.
  out = out.replace(/\$HOME\/\.claude\b/g, '$HOME/.codex');
  out = out.replace(/~\/\.claude\b/g, '~/.codex');
  out = out.replace(/(?<![A-Za-z0-9_\-.\/~$])\.claude\//g, '.codex/');

  // 4. Plugin root: resolve to where the installer actually placed the skill.
  out = out.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '~/.codex/trailhead/skill');

  return out;
}

// --- codexSkillAdapterHeader ---------------------------------------------
// Prepended (plus a blank line) to the converted SKILL.md so a Codex session
// reading the engine gets the host-mapping rules before the engine body.
function codexSkillAdapterHeader() {
  return `<codex_skill_adapter>
This trailhead engine is running on **Codex CLI**, not Claude Code. The installer projected it here; apply these host mappings as you follow the engine below.

## A. Commands
trailhead's commands are flat hyphenated Codex prompts: invoke \`/trailhead-<verb>\` (e.g. \`/trailhead-work\`), never \`/trailhead:<verb>\`. Text after the command is the arguments.

## B. No Skill tool
There is no Skill tool here. This SKILL.md (the engine) is already in your context. When the engine says to load a \`references/*.md\` file, Read it from \`~/.codex/trailhead/skill/\` (this skill directory).

## C. AskUserQuestion -> request_user_input
Where the engine uses \`AskUserQuestion\`, use Codex's \`request_user_input\`: map \`header\`->\`header\`, \`question\`->\`question\`, each option \`{label, description}\`; generate an \`id\` from the header (lowercase, spaces->underscores). Codex has no \`multiSelect\`: present sequential single-selects, or a numbered freeform list and ask for comma-separated numbers. If \`request_user_input\` is unavailable, present the choices as a plain-text numbered list and STOP for the user's reply; do not silently pick a default and proceed.

## D. No subagents (inline sequential)
Codex has no subagent/Task fan-out toolkit. Every step the engine delegates to a subagent (research, codebase-map, review, plan, execute) runs **inline and sequentially** in this one session. Every \`config.models.*\` key collapses to the single session model; no \`agents/*.toml\` exists, so there is nothing to strip.

## E. Handoff
The engine's \`/clear\` is Codex's \`/new\` (start a fresh session). Command references in a handoff use the hyphen form (\`/trailhead-work <n>\`).

## F. No lifecycle hooks
Codex has no hook bus. The commit-guard, secret-guard, injection-scanner, and check-update do NOT run as hooks here. Their protections apply as inline engine prose, plus a git \`commit-msg\` hook the engine installs at repo first-use (per the conventions/decision on lost guardrails).
</codex_skill_adapter>`;
}

// --- codexPromptFor --------------------------------------------------------
// Thin Codex prompt file body for one verb (or the bare smart-entry prompt
// when verb is null). The prompt's job is to point at the engine, not
// reimplement it: the engine (SKILL.md) is the single source of truth.
function codexPromptFor(verb, description, argHint, skillMainAbsPath) {
  // Quote the frontmatter scalars: several command descriptions carry a colon
  // (e.g. "Capture a seed: work gated on a future trigger"), and an unquoted
  // `key: a: b` is ambiguous YAML. JSON.stringify yields a valid YAML
  // double-quoted scalar (same reason GSD yamlQuote()s its descriptions).
  const yamlScalar = (s) => JSON.stringify(String(s));
  let frontmatter = `---\ndescription: ${yamlScalar(description)}\n`;
  if (argHint) frontmatter += `argument-hint: ${yamlScalar(argHint)}\n`;
  frontmatter += '---\n\n';

  const action = verb
    ? `the **${verb}** action`
    : '**smart entry** (detect the repo/map state and propose the next action)';

  const body =
    `Invoke the trailhead engine for ${action}. There is no Skill tool on Codex: Read the engine at\n` +
    `\`${skillMainAbsPath}\`\n` +
    `(the single source of truth) and carry out ${action} with these arguments: $ARGUMENTS\n` +
    `Load \`references/*.md\` from that skill directory as the instructions direct. Do not re-implement the behaviour here.\n`;

  return frontmatter + body;
}

module.exports = {
  codexLayout,
  convertToCodex,
  codexSkillAdapterHeader,
  codexPromptFor,
};
