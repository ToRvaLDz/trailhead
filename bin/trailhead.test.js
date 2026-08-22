#!/usr/bin/env node
// Integration tests for trailhead.js (the installer). Run: node trailhead.test.js
// No framework: plain asserts, mirrors the style of host-descriptor.test.js.
// Drives the real CLI via child_process against fresh temp dirs, passing an
// explicit --codex/--claude flag (or a controlled $PATH for the auto-detect
// cases) plus --dir= so no TTY prompt can fire.
//
// Since #25, BOTH codex and claude installs produce <dir>/skills/trailhead/
// SKILL.md, so that path alone no longer tells them apart. Distinguish by:
// codex has NO commands/ dir and NO settings.json (still Claude-only), but
// (since #29) DOES have hooks.json + skills/trailhead/hooks/ + config.toml,
// and its SKILL.md STARTS WITH <codex_skill_adapter> plus a
// skills/trailhead/agents/openai.yaml; claude HAS commands/trailhead/,
// settings.json, hooks/, and its SKILL.md does NOT start with the adapter
// header.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const repoRoot = path.resolve(__dirname, '..');
const installerPath = path.join(repoRoot, 'bin', 'trailhead.js');
const tmpDirs = [];

function mktmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  tmpDirs.push(d);
  return d;
}

// process.execPath (not the bare 'node') so a test can hand a stripped-down
// $PATH to exercise the auto-detect branch without losing the node binary.
function runInstaller(extraArgs, opts = {}) {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const cwd = opts.cwd || repoRoot;
  return execFileSync(process.execPath, [installerPath, ...extraArgs], { cwd, stdio: 'pipe', env });
}

// A dir holding an executable stub for each named host CLI, so detectInstalledHosts
// finds them when this dir is the whole $PATH.
function fakeBinDir(names) {
  const dir = mktmp();
  for (const name of names) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

// --- codex install -----------------------------------------------------------
const codexDir = mktmp();
runInstaller([`--codex`, `--dir=${codexDir}`]);

const skillMainPath = path.join(codexDir, 'skills', 'trailhead', 'SKILL.md');
ok('codex: SKILL.md exists', fs.existsSync(skillMainPath));
const skillMainContent = fs.readFileSync(skillMainPath, 'utf8');
// #40: the YAML frontmatter must stay at the very top (Codex only registers a
// skill when `name:`/`description:` are the first bytes); the adapter header is
// injected AFTER the frontmatter, not above it.
ok('codex: SKILL.md starts with the YAML frontmatter', skillMainContent.startsWith('---\n'));
ok('codex: SKILL.md frontmatter precedes the adapter header',
  skillMainContent.indexOf('name: trailhead') < skillMainContent.indexOf('<codex_skill_adapter>'));
ok('codex: SKILL.md still carries the adapter header', skillMainContent.includes('<codex_skill_adapter>'));
// The adapter header itself (mandated EXACT text) intentionally contrasts the
// $trailhead form with the old slash-namespace form ("Never /trailhead:<verb>"),
// so it legitimately contains that substring once. Scope the check to the
// converted engine body, after the header, which is where the command-surface
// rewrite actually applies.
const engineBody = skillMainContent.slice(skillMainContent.indexOf('</codex_skill_adapter>'));
ok('codex: SKILL.md engine body has no /trailhead: substring', !engineBody.includes('/trailhead:'));

ok('codex: references/techniques/grilling.md exists', fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'references', 'techniques', 'grilling.md')));

const agentsYamlPath = path.join(codexDir, 'skills', 'trailhead', 'agents', 'openai.yaml');
ok('codex: agents/openai.yaml exists', fs.existsSync(agentsYamlPath));
ok('codex: agents/openai.yaml disallows implicit invocation', fs.readFileSync(agentsYamlPath, 'utf8').includes('allow_implicit_invocation: false'));

const codexTemplate = path.join(codexDir, 'skills', 'trailhead', 'templates', 'trailhead-commit-msg');
ok('codex: commit-msg template projected', fs.existsSync(codexTemplate));
ok('codex: commit-msg template is verbatim (not converted)',
  fs.readFileSync(codexTemplate, 'utf8') === fs.readFileSync(path.join(repoRoot, 'plugins', 'trailhead', 'templates', 'trailhead-commit-msg'), 'utf8'));

ok('codex: no commands dir', !fs.existsSync(path.join(codexDir, 'commands')));
ok('codex: no settings.json file', !fs.existsSync(path.join(codexDir, 'settings.json')));
// #46: per-verb discoverability now projects one Codex SKILL per verb
// (skills/trailhead-<verb>/), invocable as $trailhead-<verb>. The old
// ~/.codex/prompts/ shims never surfaced as slash commands on Codex.
ok('codex: per-verb skills/trailhead-work/SKILL.md exists', fs.existsSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md')));
ok('codex: per-verb skills/trailhead-bug/SKILL.md exists', fs.existsSync(path.join(codexDir, 'skills', 'trailhead-bug', 'SKILL.md')));
ok('codex: trailhead-work SKILL.md frontmatter is at byte 0', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md'), 'utf8').startsWith('---\nname: trailhead-work\n'));
ok('codex: trailhead-work skill delegates to $trailhead work', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md'), 'utf8').includes('$trailhead work'));
ok('codex: per-verb skill is explicit-only', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'agents', 'openai.yaml'), 'utf8').includes('allow_implicit_invocation: false'));
ok('codex: no ~/.codex/prompts shims left (old mechanism dropped)', !fs.existsSync(path.join(codexDir, 'prompts', 'trailhead.md')) && !fs.existsSync(path.join(codexDir, 'prompts', 'trailhead-work.md')));

// --- codex hooks (#29) --------------------------------------------------------
const codexHooksJsonPath = path.join(codexDir, 'hooks.json');
ok('codex: hooks.json exists', fs.existsSync(codexHooksJsonPath));
const codexHooksJson = JSON.parse(fs.readFileSync(codexHooksJsonPath, 'utf8'));
const codexHooksJsonStr = JSON.stringify(codexHooksJson);
ok('codex: hooks.json registers commit-guard under PreToolUse', codexHooksJsonStr.includes('trailhead-commit-guard.js') &&
  (codexHooksJson.hooks.PreToolUse || []).some((g) => (g.hooks || []).some((h) => h.command.includes('trailhead-commit-guard.js'))));
ok('codex: hooks.json registers secret-guard under PreToolUse', (codexHooksJson.hooks.PreToolUse || []).some((g) => (g.hooks || []).some((h) => h.command.includes('trailhead-secret-guard.js'))));
ok('codex: hooks.json registers injection-scanner under PostToolUse', (codexHooksJson.hooks.PostToolUse || []).some((g) => (g.hooks || []).some((h) => h.command.includes('trailhead-issue-injection-scanner.js'))));
ok('codex: hooks.json registers check-update under SessionStart', (codexHooksJson.hooks.SessionStart || []).some((g) => (g.hooks || []).some((h) => h.command.includes('trailhead-check-update.js'))));

ok('codex: skills/trailhead/hooks/trailhead-secret-guard.js exists', fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')));
ok('codex: skills/trailhead/hooks/lib/commit-message-check.js exists (commit-guard require target)',
  fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'lib', 'commit-message-check.js')));

const codexConfigTomlPath = path.join(codexDir, 'config.toml');
ok('codex: config.toml exists', fs.existsSync(codexConfigTomlPath));
ok('codex: config.toml enables hooks feature', fs.readFileSync(codexConfigTomlPath, 'utf8').includes('hooks = true'));
// v2 is gated on projected pins: this install (repoRoot, no models.codex.*)
// projects none, so multi_agent_v2 stays OFF (base multi_agent still fans out;
// adapter §D expects no trailhead agent_type registry in the no-pins case).
ok('codex: config.toml does NOT enable multi_agent_v2 when no models.codex.* pins are projected',
  !fs.readFileSync(codexConfigTomlPath, 'utf8').includes('multi_agent_v2 = true'));

// --- codex agent TOML projection (#38) -----------------------------------------
// repoRoot's own .trailhead/config.json has no models.codex.*, so a plain
// install (cwd: repoRoot, no models.codex anywhere) projects no agent TOMLs.
ok('codex: no trailhead-*.toml under agents/ when models.codex.* is unset',
  !fs.existsSync(path.join(codexDir, 'agents')) ||
  !fs.readdirSync(path.join(codexDir, 'agents')).some((f) => /^trailhead-.*\.toml$/.test(f)));

// --- codex migration (#46): install over old prompt shims sweeps them --------
const migCodexDir = mktmp();
fs.mkdirSync(path.join(migCodexDir, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(migCodexDir, 'prompts', 'trailhead.md'), 'stale bare shim\n');
fs.writeFileSync(path.join(migCodexDir, 'prompts', 'trailhead-work.md'), 'stale verb shim\n');
runInstaller([`--codex`, `--dir=${migCodexDir}`]);
ok('codex migration: stale prompts/trailhead.md swept on install', !fs.existsSync(path.join(migCodexDir, 'prompts', 'trailhead.md')));
ok('codex migration: stale prompts/trailhead-work.md swept on install', !fs.existsSync(path.join(migCodexDir, 'prompts', 'trailhead-work.md')));
ok('codex migration: per-verb skill projected in its place', fs.existsSync(path.join(migCodexDir, 'skills', 'trailhead-work', 'SKILL.md')));

// --- codex uninstall (same tmp) ----------------------------------------------
runInstaller([`--codex`, `--dir=${codexDir}`, '--uninstall']);
ok('codex uninstall: skills/trailhead gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead')));
ok('codex uninstall: legacy trailhead engine dir gone', !fs.existsSync(path.join(codexDir, 'trailhead')));
ok('codex uninstall: per-verb skills/trailhead-work gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead-work')));
ok('codex uninstall: per-verb skills/trailhead-bug gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead-bug')));
ok('codex uninstall: hooks.json no longer contains trailhead commands', (() => {
  const h = JSON.parse(fs.readFileSync(codexHooksJsonPath, 'utf8'));
  const str = JSON.stringify(h);
  return !str.includes('trailhead-commit-guard.js') && !str.includes('trailhead-secret-guard.js') &&
    !str.includes('trailhead-issue-injection-scanner.js') && !str.includes('trailhead-check-update.js');
})());

// --- claude regression --------------------------------------------------------
const claudeDir = mktmp();
runInstaller([`--claude`, `--dir=${claudeDir}`]);

const claudeSkillPath = path.join(claudeDir, 'skills', 'trailhead', 'SKILL.md');
ok('claude: skills/trailhead/SKILL.md exists', fs.existsSync(claudeSkillPath));
ok('claude: commands/trailhead/work.md exists', fs.existsSync(path.join(claudeDir, 'commands', 'trailhead', 'work.md')));
ok('claude: hooks/trailhead-commit-guard.js exists', fs.existsSync(path.join(claudeDir, 'hooks', 'trailhead-commit-guard.js')));
ok('claude: hooks/lib/commit-message-check.js exists (commit-guard require target)',
  fs.existsSync(path.join(claudeDir, 'hooks', 'lib', 'commit-message-check.js')));
// Regression: the commit-guard does require('./lib/commit-message-check.js'), so
// it only loads if the lib was copied alongside it. Run it with a benign Bash
// payload and assert it does not crash with a missing-module error.
ok('claude: trailhead-commit-guard.js loads without MODULE_NOT_FOUND', (() => {
  let out = '';
  try {
    out = String(execFileSync(process.execPath, [path.join(claudeDir, 'hooks', 'trailhead-commit-guard.js')],
      { input: '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}', stdio: 'pipe' }));
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  return !out.includes('MODULE_NOT_FOUND') && !out.includes('Cannot find module');
})());
ok('claude: SKILL.md does not start with the codex adapter header', !fs.readFileSync(claudeSkillPath, 'utf8').startsWith('<codex_skill_adapter>'));

// --- claude uninstall: remove trailhead's lib, keep a co-tenant's -------------
// The Claude hooks/lib dir is shared with other plugins. Drop a fake co-tenant
// lib next to trailhead's, uninstall, and assert only trailhead's own lib file
// is removed (never a recursive wipe of the shared dir).
const coTenantDir = mktmp();
runInstaller([`--claude`, `--dir=${coTenantDir}`]);
const coTenantLib = path.join(coTenantDir, 'hooks', 'lib', 'other-plugin-lib.js');
fs.writeFileSync(coTenantLib, '// not trailhead\n');
runInstaller([`--claude`, `--dir=${coTenantDir}`, '--uninstall']);
ok('claude uninstall: trailhead lib removed', !fs.existsSync(path.join(coTenantDir, 'hooks', 'lib', 'commit-message-check.js')));
ok('claude uninstall: co-tenant lib preserved (no recursive wipe)', fs.existsSync(coTenantLib));

const settingsPath = path.join(claudeDir, 'settings.json');
ok('claude: settings.json exists', fs.existsSync(settingsPath));
const settingsContent = fs.readFileSync(settingsPath, 'utf8');
ok('claude: settings.json references commit-guard', settingsContent.includes('trailhead-commit-guard.js'));

// --- auto-detect: exactly one CLI on $PATH -> install for it, no flag ----------
// Only a fake `codex` on $PATH: the installer must pick codex on its own.
const autoCodexDir = mktmp();
runInstaller([`--dir=${autoCodexDir}`], { env: { PATH: fakeBinDir(['codex']) } });
const autoCodexSkillPath = path.join(autoCodexDir, 'skills', 'trailhead', 'SKILL.md');
ok('auto-detect codex: skills/trailhead/SKILL.md exists', fs.existsSync(autoCodexSkillPath));
ok('auto-detect codex: SKILL.md carries the adapter header (proves codex layout)', fs.readFileSync(autoCodexSkillPath, 'utf8').includes('<codex_skill_adapter>'));
ok('auto-detect codex: did not install the Claude layout (no commands/trailhead)', !fs.existsSync(path.join(autoCodexDir, 'commands', 'trailhead')));
ok('auto-detect codex: did not install the Claude layout (no settings.json)', !fs.existsSync(path.join(autoCodexDir, 'settings.json')));

// Only a fake `claude` on $PATH: the installer must pick claude on its own.
const autoClaudeDir = mktmp();
runInstaller([`--dir=${autoClaudeDir}`], { env: { PATH: fakeBinDir(['claude']) } });
const autoClaudeSkillPath = path.join(autoClaudeDir, 'skills', 'trailhead', 'SKILL.md');
ok('auto-detect claude: skills/trailhead/SKILL.md exists', fs.existsSync(autoClaudeSkillPath));
ok('auto-detect claude: commands/trailhead/work.md exists (proves claude layout)', fs.existsSync(path.join(autoClaudeDir, 'commands', 'trailhead', 'work.md')));
ok('auto-detect claude: SKILL.md does not start with adapter header', !fs.readFileSync(autoClaudeSkillPath, 'utf8').startsWith('<codex_skill_adapter>'));

// --- auto-detect: ambiguous + non-interactive -> claude fallback --------------
// No CLI on $PATH and non-interactive (piped stdio): must fall back to claude.
const fallbackDir = mktmp();
runInstaller([`--dir=${fallbackDir}`], { env: { PATH: fakeBinDir([]) } });
const fallbackSkillPath = path.join(fallbackDir, 'skills', 'trailhead', 'SKILL.md');
ok('ambiguous fallback: installs the Claude layout', fs.existsSync(fallbackSkillPath));
ok('ambiguous fallback: settings.json exists (proves claude layout)', fs.existsSync(path.join(fallbackDir, 'settings.json')));
ok('ambiguous fallback: SKILL.md does not start with adapter header', !fs.readFileSync(fallbackSkillPath, 'utf8').startsWith('<codex_skill_adapter>'));

// --- both --codex and --claude -> hard error ----------------------------------
let bothRejected = false;
try {
  runInstaller([`--codex`, `--claude`, `--dir=${mktmp()}`]);
} catch (e) {
  bothRejected = true;
}
ok('conflicting --codex --claude is rejected', bothRejected);

// --- legacy --host= is no longer a host selector ------------------------------
// It must not silently install codex; with no real flag it auto-detects, and
// here $PATH has only claude, so a stray --host=codex still yields claude.
const legacyDir = mktmp();
runInstaller([`--host=codex`, `--dir=${legacyDir}`], { env: { PATH: fakeBinDir(['claude']) } });
const legacySkillPath = path.join(legacyDir, 'skills', 'trailhead', 'SKILL.md');
ok('legacy --host=codex is ignored (auto-detect wins)', fs.existsSync(legacySkillPath));
ok('legacy --host=codex is ignored: settings.json exists (proves claude layout)', fs.existsSync(path.join(legacyDir, 'settings.json')));
ok('legacy --host=codex is ignored: SKILL.md does not start with adapter header', !fs.readFileSync(legacySkillPath, 'utf8').startsWith('<codex_skill_adapter>'));

// --- codex agent TOML projection: a real models.codex.* pin (#38) --------------
// A temp "project" dir with .trailhead/config.json setting models.codex.execute;
// running the installer with that dir as cwd (and a separate codex-home tmp dir
// as --dir=) must project trailhead-execute.toml under <codexHome>/agents/.
const projectDir = mktmp();
fs.mkdirSync(path.join(projectDir, '.trailhead'), { recursive: true });
fs.writeFileSync(
  path.join(projectDir, '.trailhead', 'config.json'),
  JSON.stringify({ models: { codex: { execute: 'gpt-5.6-terra' } } }, null, 2) + '\n'
);
const pinCodexHomeDir = mktmp();
runInstaller([`--codex`, `--dir=${pinCodexHomeDir}`], { cwd: projectDir });

const pinnedTomlPath = path.join(pinCodexHomeDir, 'agents', 'trailhead-execute.toml');
ok('codex: models.codex.execute projects trailhead-execute.toml', fs.existsSync(pinnedTomlPath));
const pinnedTomlContent = fs.existsSync(pinnedTomlPath) ? fs.readFileSync(pinnedTomlPath, 'utf8') : '';
ok('codex: trailhead-execute.toml has the pinned model', pinnedTomlContent.includes('model = "gpt-5.6-terra"'));
ok('codex: trailhead-execute.toml has the right name', pinnedTomlContent.includes('name = "trailhead-execute"'));
// With a real pin projected, v2 IS enabled so Codex honours the agent_type registry.
const pinConfigTomlPath = path.join(pinCodexHomeDir, 'config.toml');
ok('codex: config.toml enables multi_agent_v2 when a models.codex.* pin is projected',
  fs.existsSync(pinConfigTomlPath) && fs.readFileSync(pinConfigTomlPath, 'utf8').includes('multi_agent_v2 = true'));

// Uninstall must sweep the projected TOML too, without a --dir= cwd dependency.
runInstaller([`--codex`, `--dir=${pinCodexHomeDir}`, '--uninstall']);
ok('codex uninstall: trailhead-execute.toml is gone', !fs.existsSync(pinnedTomlPath));

// --- cleanup -------------------------------------------------------------------
for (const d of tmpDirs) {
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`✓ trailhead.js (installer): ${passed} assertions passed`);
