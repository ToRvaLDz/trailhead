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

ok('codex: _shared/techniques/grilling.md exists', fs.existsSync(path.join(codexDir, 'skills', '_shared', 'techniques', 'grilling.md')));

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
// #46 per-verb discoverability skills. `work` collides with the work CLUSTER
// dir, so its discoverability is the cluster itself; use a non-colliding verb.
ok('codex: per-verb skills/trailhead-bug/SKILL.md exists', fs.existsSync(path.join(codexDir, 'skills', 'trailhead-bug', 'SKILL.md')));
ok('codex: trailhead-bug SKILL.md frontmatter is at byte 0', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-bug', 'SKILL.md'), 'utf8').startsWith('---\nname: trailhead-bug\n'));
ok('codex: trailhead-bug skill delegates to $trailhead bug', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-bug', 'SKILL.md'), 'utf8').includes('$trailhead bug'));
ok('codex: per-verb skill is explicit-only', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-bug', 'agents', 'openai.yaml'), 'utf8').includes('allow_implicit_invocation: false'));
// The trailhead-work dir is the WORK CLUSTER skill (not a thin verb delegator).
ok('codex: trailhead-work is the cluster skill (frontmatter name at byte 0)', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md'), 'utf8').startsWith('---\nname: trailhead-work\n'));
ok('codex: trailhead-work cluster carries the adapter header', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md'), 'utf8').includes('<codex_skill_adapter>'));
ok('codex: NO thin trailhead-work verb-delegator (cluster occupies the name)', !fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md'), 'utf8').includes('This is a thin discoverability entry'));
ok('codex: no ~/.codex/prompts shims left (old mechanism dropped)', !fs.existsSync(path.join(codexDir, 'prompts', 'trailhead.md')) && !fs.existsSync(path.join(codexDir, 'prompts', 'trailhead-work.md')));

// The split ships all sibling engine skills so the ../_shared/ relative refs resolve.
ok('codex: _shared/ projected', fs.existsSync(path.join(codexDir, 'skills', '_shared', 'substrate.md')));
for (const cl of ['trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage']) {
  ok(`codex: cluster ${cl} SKILL.md projected`, fs.existsSync(path.join(codexDir, 'skills', cl, 'SKILL.md')));
  ok(`codex: cluster ${cl} carries the adapter header`, fs.readFileSync(path.join(codexDir, 'skills', cl, 'SKILL.md'), 'utf8').includes('<codex_skill_adapter>'));
  ok(`codex: cluster ${cl} frontmatter precedes the adapter header`, (() => { const c = fs.readFileSync(path.join(codexDir, 'skills', cl, 'SKILL.md'), 'utf8'); return c.startsWith('---\n') && c.indexOf('name:') < c.indexOf('<codex_skill_adapter>'); })());
  ok(`codex: cluster ${cl} agents/openai.yaml explicit-only`, fs.readFileSync(path.join(codexDir, 'skills', cl, 'agents', 'openai.yaml'), 'utf8').includes('allow_implicit_invocation: false'));
}
// A cluster's ../_shared/ reference target actually resolves as a sibling.
ok('codex: trailhead-work/../_shared/substrate.md resolves', fs.existsSync(path.join(codexDir, 'skills', 'trailhead-work', '..', '_shared', 'substrate.md')));

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
// All 7 agents are always projected uniformly (pinned or pin-less), so
// multi_agent_v2 is ON even with no models.codex.* set (this install,
// repoRoot, sets none): the adapter §D registry is always present.
ok('codex: config.toml enables multi_agent_v2 even with no models.codex.* pins projected',
  fs.readFileSync(codexConfigTomlPath, 'utf8').includes('multi_agent_v2 = true'));

const codexAgentsDirPath = path.join(codexDir, 'agents');
const noPinFixTomlPath = path.join(codexAgentsDirPath, 'trailhead-fix.toml');
const noPinMapTomlPath = path.join(codexAgentsDirPath, 'trailhead-codebase-map.toml');
ok('codex: trailhead-fix.toml is projected with no models.codex.* set', fs.existsSync(noPinFixTomlPath));
ok('codex: trailhead-codebase-map.toml is projected with no models.codex.* set', fs.existsSync(noPinMapTomlPath));
ok('codex: trailhead-fix.toml is pin-less (no model = line) with no models.codex.* set',
  fs.existsSync(noPinFixTomlPath) && !/^model = /m.test(fs.readFileSync(noPinFixTomlPath, 'utf8')));

// --- codex --symlink: link verbatim artifacts (hooks + templates), keep skills projected ---
const codexSymDir = mktmp();
runInstaller([`--codex`, `--symlink`, `--dir=${codexSymDir}`]);
ok('codex symlink: skills/trailhead/hooks/trailhead-secret-guard.js is a symlink',
  fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
ok('codex symlink: skills/trailhead/hooks/lib/commit-message-check.js is a symlink',
  fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'hooks', 'lib', 'commit-message-check.js')).isSymbolicLink());
ok('codex symlink: skills/trailhead/templates is a symlink',
  fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'templates')).isSymbolicLink());
ok('codex symlink: a hook symlink resolves into the package source',
  fs.realpathSync(path.join(codexSymDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')) ===
  fs.realpathSync(path.join(repoRoot, 'plugins', 'trailhead', 'hooks', 'trailhead-secret-guard.js')));
ok('codex symlink: converted SKILL.md stays a regular file (projected, not linked)',
  !fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'SKILL.md')).isSymbolicLink());
// Reinstall over the existing symlink install must not throw (EEXIST guard).
runInstaller([`--codex`, `--symlink`, `--dir=${codexSymDir}`]);
ok('codex symlink: reinstall over existing symlinks succeeds',
  fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
// Default (copy) codex install keeps hooks/templates as real files, not symlinks.
ok('codex copy: hooks are regular files (not symlinks)',
  !fs.lstatSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
ok('codex copy: templates is a regular dir (not a symlink)',
  !fs.lstatSync(path.join(codexDir, 'skills', 'trailhead', 'templates')).isSymbolicLink());

// --- codex agent TOML projection (#38, #88) -------------------------------------
// repoRoot's own .trailhead/config.json has no models.codex.*, so a plain
// install (cwd: repoRoot, no models.codex anywhere) still projects all 7
// agents pin-less (uniform projection, #88), never zero.
ok('codex: all 7 trailhead-*.toml exist under agents/ even with models.codex.* unset', (() => {
  const dir = path.join(codexDir, 'agents');
  if (!fs.existsSync(dir)) return false;
  const tomls = fs.readdirSync(dir).filter((f) => /^trailhead-.*\.toml$/.test(f));
  return tomls.length === 7;
})());
ok('codex: every trailhead-*.toml is pin-less when models.codex.* is unset', (() => {
  const dir = path.join(codexDir, 'agents');
  const tomls = fs.readdirSync(dir).filter((f) => /^trailhead-.*\.toml$/.test(f));
  return tomls.every((f) => !/^model = /m.test(fs.readFileSync(path.join(dir, f), 'utf8')));
})());

// --- codex migration (#46): install over old prompt shims sweeps them --------
const migCodexDir = mktmp();
fs.mkdirSync(path.join(migCodexDir, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(migCodexDir, 'prompts', 'trailhead.md'), 'stale bare shim\n');
fs.writeFileSync(path.join(migCodexDir, 'prompts', 'trailhead-work.md'), 'stale verb shim\n');
runInstaller([`--codex`, `--dir=${migCodexDir}`]);
ok('codex migration: stale prompts/trailhead.md swept on install', !fs.existsSync(path.join(migCodexDir, 'prompts', 'trailhead.md')));
ok('codex migration: stale prompts/trailhead-work.md swept on install', !fs.existsSync(path.join(migCodexDir, 'prompts', 'trailhead-work.md')));
ok('codex migration: per-verb skill projected in its place', fs.existsSync(path.join(migCodexDir, 'skills', 'trailhead-work', 'SKILL.md')));

// codex migration: a stale trailhead-owned skill dir (pre-split monolith /
// removed cluster) is swept on reinstall; a co-tenant skill is preserved.
const migCodexSkillDir = mktmp();
runInstaller([`--codex`, `--dir=${migCodexSkillDir}`]);
fs.mkdirSync(path.join(migCodexSkillDir, 'skills', 'trailhead-monolith'), { recursive: true });
fs.writeFileSync(path.join(migCodexSkillDir, 'skills', 'trailhead-monolith', 'SKILL.md'), 'stale\n');
fs.mkdirSync(path.join(migCodexSkillDir, 'skills', 'other-plugin'), { recursive: true });
fs.writeFileSync(path.join(migCodexSkillDir, 'skills', 'other-plugin', 'SKILL.md'), 'co-tenant\n');
runInstaller([`--codex`, `--dir=${migCodexSkillDir}`]);
ok('codex migration: stale trailhead-monolith skill dir swept on reinstall', !fs.existsSync(path.join(migCodexSkillDir, 'skills', 'trailhead-monolith')));
ok('codex migration: co-tenant skill preserved', fs.existsSync(path.join(migCodexSkillDir, 'skills', 'other-plugin')));

// --- codex uninstall (same tmp) ----------------------------------------------
runInstaller([`--codex`, `--dir=${codexDir}`, '--uninstall']);
ok('codex uninstall: skills/trailhead gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead')));
ok('codex uninstall: legacy trailhead engine dir gone', !fs.existsSync(path.join(codexDir, 'trailhead')));
ok('codex uninstall: per-verb skills/trailhead-work gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead-work')));
ok('codex uninstall: per-verb skills/trailhead-bug gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead-bug')));
ok('codex uninstall: _shared gone', !fs.existsSync(path.join(codexDir, 'skills', '_shared')));
ok('codex uninstall: cluster trailhead-view gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead-view')));
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
// The split ships all sibling engine skills on Claude too.
ok('claude: skills/_shared/substrate.md exists', fs.existsSync(path.join(claudeDir, 'skills', '_shared', 'substrate.md')));
for (const cl of ['trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage']) {
  ok(`claude: skills/${cl}/SKILL.md exists`, fs.existsSync(path.join(claudeDir, 'skills', cl, 'SKILL.md')));
}
ok('claude: cluster ../_shared/ reference resolves', fs.existsSync(path.join(claudeDir, 'skills', 'trailhead-work', '..', '_shared', 'substrate.md')));
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

// --- claude: engine agents registered as user subagents -----------------------
// Without these under <configDir>/agents/, every technique dispatch fails and
// falls back to running inline on the session model, so the per-technique
// config.models.* split silently never applies.
const claudeAgentsDir = path.join(claudeDir, 'agents');
const expectedAgents = ['trailhead-plan', 'trailhead-executor', 'trailhead-research', 'trailhead-code-review', 'trailhead-debug', 'trailhead-fix', 'trailhead-codebase-map'];
for (const a of expectedAgents) {
  ok(`claude: agents/${a}.md placed`, fs.existsSync(path.join(claudeAgentsDir, `${a}.md`)));
}
ok('claude: agent file registers its subagent name in frontmatter',
  fs.readFileSync(path.join(claudeAgentsDir, 'trailhead-executor.md'), 'utf8').startsWith('---\nname: trailhead-executor\n'));
ok('claude: agents are real files on a copy install (not symlinks)',
  !fs.lstatSync(path.join(claudeAgentsDir, 'trailhead-plan.md')).isSymbolicLink());

// --- claude --symlink: dev install links hooks live too (not just skills/commands) ---
const symDir = mktmp();
runInstaller([`--claude`, `--symlink`, `--dir=${symDir}`]);
ok('claude symlink: skills/trailhead is a symlink',
  fs.lstatSync(path.join(symDir, 'skills', 'trailhead')).isSymbolicLink());
ok('claude symlink: hooks/trailhead-secret-guard.js is a symlink',
  fs.lstatSync(path.join(symDir, 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
ok('claude symlink: hooks/lib/commit-message-check.js is a symlink',
  fs.lstatSync(path.join(symDir, 'hooks', 'lib', 'commit-message-check.js')).isSymbolicLink());
ok('claude symlink: hook symlink resolves into the package source',
  fs.realpathSync(path.join(symDir, 'hooks', 'trailhead-secret-guard.js')) ===
  fs.realpathSync(path.join(repoRoot, 'plugins', 'trailhead', 'hooks', 'trailhead-secret-guard.js')));
ok('claude symlink: a symlinked commit-guard still loads its lib (no MODULE_NOT_FOUND)', (() => {
  let out = '';
  try {
    out = String(execFileSync(process.execPath, [path.join(symDir, 'hooks', 'trailhead-commit-guard.js')],
      { input: '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}', stdio: 'pipe' }));
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  return !out.includes('MODULE_NOT_FOUND') && !out.includes('Cannot find module');
})());
// Reinstalling over an existing symlink install must not throw (EEXIST guard).
runInstaller([`--claude`, `--symlink`, `--dir=${symDir}`]);
ok('claude symlink: reinstall over existing symlinks succeeds',
  fs.lstatSync(path.join(symDir, 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
ok('claude symlink: agents/trailhead-plan.md is a symlink',
  fs.lstatSync(path.join(symDir, 'agents', 'trailhead-plan.md')).isSymbolicLink());
ok('claude symlink: agent symlink resolves into the package source',
  fs.realpathSync(path.join(symDir, 'agents', 'trailhead-plan.md')) ===
  fs.realpathSync(path.join(repoRoot, 'plugins', 'trailhead', 'agents', 'trailhead-plan.md')));
// Default (copy) install keeps hooks as real files, not symlinks.
ok('claude copy: hooks/trailhead-secret-guard.js is a regular file (not a symlink)',
  !fs.lstatSync(path.join(claudeDir, 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());

// --- claude migration: reinstall over an old layout sweeps stale skill dirs ---
// An old install may carry a pre-split monolith (skills/trailhead-monolith) or a
// removed cluster (skills/trailhead-legacy) the current install no longer ships.
// Reinstalling must sweep every stale trailhead-owned skill dir, while leaving a
// co-tenant plugin's own skill (skills/other-plugin) untouched.
const migClaudeDir = mktmp();
runInstaller([`--claude`, `--dir=${migClaudeDir}`]);
fs.mkdirSync(path.join(migClaudeDir, 'skills', 'trailhead-monolith'), { recursive: true });
fs.writeFileSync(path.join(migClaudeDir, 'skills', 'trailhead-monolith', 'SKILL.md'), 'stale monolith\n');
fs.mkdirSync(path.join(migClaudeDir, 'skills', 'trailhead-legacy'), { recursive: true });
fs.writeFileSync(path.join(migClaudeDir, 'skills', 'trailhead-legacy', 'SKILL.md'), 'stale cluster\n');
fs.mkdirSync(path.join(migClaudeDir, 'skills', 'other-plugin'), { recursive: true });
fs.writeFileSync(path.join(migClaudeDir, 'skills', 'other-plugin', 'SKILL.md'), 'co-tenant\n');
runInstaller([`--claude`, `--dir=${migClaudeDir}`]);
ok('claude migration: stale trailhead-monolith swept on reinstall', !fs.existsSync(path.join(migClaudeDir, 'skills', 'trailhead-monolith')));
ok('claude migration: stale trailhead-legacy cluster swept on reinstall', !fs.existsSync(path.join(migClaudeDir, 'skills', 'trailhead-legacy')));
ok('claude migration: co-tenant skill preserved (only trailhead names swept)', fs.existsSync(path.join(migClaudeDir, 'skills', 'other-plugin')));
ok('claude migration: current dispatcher present after reinstall', fs.existsSync(path.join(migClaudeDir, 'skills', 'trailhead', 'SKILL.md')));
ok('claude migration: current cluster present after reinstall', fs.existsSync(path.join(migClaudeDir, 'skills', 'trailhead-work', 'SKILL.md')));
// The agents dir gets the same name-only sweep on reinstall: a stale trailhead
// agent (renamed/removed) is swept, a co-tenant agent left alone.
fs.writeFileSync(path.join(migClaudeDir, 'agents', 'trailhead-oldagent.md'), '---\nname: trailhead-oldagent\n---\n');
fs.writeFileSync(path.join(migClaudeDir, 'agents', 'other-plugin-agent.md'), '---\nname: other-plugin-agent\n---\n');
runInstaller([`--claude`, `--dir=${migClaudeDir}`]);
ok('claude migration: stale trailhead-oldagent.md swept on reinstall', !fs.existsSync(path.join(migClaudeDir, 'agents', 'trailhead-oldagent.md')));
ok('claude migration: co-tenant agent preserved on reinstall', fs.existsSync(path.join(migClaudeDir, 'agents', 'other-plugin-agent.md')));
ok('claude migration: engine agents present after reinstall', fs.existsSync(path.join(migClaudeDir, 'agents', 'trailhead-executor.md')));

// Uninstall also sweeps a stale trailhead-owned dir the current package no
// longer ships (monolith), not just the current engineSkillDirs() set.
const uninstMigDir = mktmp();
runInstaller([`--claude`, `--dir=${uninstMigDir}`]);
fs.mkdirSync(path.join(uninstMigDir, 'skills', 'trailhead-monolith'), { recursive: true });
fs.writeFileSync(path.join(uninstMigDir, 'skills', 'trailhead-monolith', 'SKILL.md'), 'stale\n');
runInstaller([`--claude`, `--dir=${uninstMigDir}`, '--uninstall']);
ok('claude uninstall: stale trailhead-monolith swept too', !fs.existsSync(path.join(uninstMigDir, 'skills', 'trailhead-monolith')));

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

// The agents dir is shared too: a co-tenant's own agent survives uninstall,
// while trailhead's are removed by name.
const coTenantAgentDir = mktmp();
runInstaller([`--claude`, `--dir=${coTenantAgentDir}`]);
const foreignAgent = path.join(coTenantAgentDir, 'agents', 'other-plugin-agent.md');
fs.writeFileSync(foreignAgent, '---\nname: other-plugin-agent\n---\n');
ok('claude: engine agent present before uninstall', fs.existsSync(path.join(coTenantAgentDir, 'agents', 'trailhead-plan.md')));
runInstaller([`--claude`, `--dir=${coTenantAgentDir}`, '--uninstall']);
ok('claude uninstall: trailhead agents removed by name', !fs.existsSync(path.join(coTenantAgentDir, 'agents', 'trailhead-plan.md')));
ok('claude uninstall: co-tenant agent preserved (no recursive wipe)', fs.existsSync(foreignAgent));

// Uninstall removes every split skill (dispatcher + clusters + _shared) by name.
const splitDir = mktmp();
runInstaller([`--claude`, `--dir=${splitDir}`]);
runInstaller([`--claude`, `--dir=${splitDir}`, '--uninstall']);
for (const nm of ['trailhead', 'trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage', '_shared']) {
  ok(`claude uninstall: skills/${nm} removed`, !fs.existsSync(path.join(splitDir, 'skills', nm)));
}

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
