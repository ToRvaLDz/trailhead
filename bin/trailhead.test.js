#!/usr/bin/env node
// Integration tests for trailhead.js (the installer). Run: node trailhead.test.js
// No framework: plain asserts, mirrors the style of host-descriptor.test.js.
// Drives the real CLI via child_process against fresh temp dirs, passing an
// explicit --codex/--claude flag (or a controlled $PATH for the auto-detect
// cases) plus --dir= so no TTY prompt can fire.
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
  return execFileSync(process.execPath, [installerPath, ...extraArgs], { cwd: repoRoot, stdio: 'pipe', env });
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

ok('codex: trailhead-work.md prompt exists', fs.existsSync(path.join(codexDir, 'prompts', 'trailhead-work.md')));
ok('codex: bare trailhead.md prompt exists', fs.existsSync(path.join(codexDir, 'prompts', 'trailhead.md')));

const skillMainPath = path.join(codexDir, 'trailhead', 'skill', 'SKILL.md');
ok('codex: SKILL.md exists', fs.existsSync(skillMainPath));
const skillMainContent = fs.readFileSync(skillMainPath, 'utf8');
ok('codex: SKILL.md starts with adapter header', skillMainContent.startsWith('<codex_skill_adapter>'));
// The adapter header itself (Task 1c's mandated EXACT text) intentionally
// contrasts the hyphen form with the old slash-namespace form ("never
// `/trailhead:<verb>`"), so it legitimately contains that substring once.
// Scope the "fully hyphenated" check to the converted engine body, after
// the header, which is where the command-surface rewrite actually applies.
const engineBody = skillMainContent.slice(skillMainContent.indexOf('</codex_skill_adapter>'));
ok('codex: SKILL.md engine body has no /trailhead: substring', !engineBody.includes('/trailhead:'));

ok('codex: references/techniques/grilling.md exists', fs.existsSync(path.join(codexDir, 'trailhead', 'skill', 'references', 'techniques', 'grilling.md')));

const codexTemplate = path.join(codexDir, 'trailhead', 'templates', 'trailhead-commit-msg');
ok('codex: commit-msg template projected', fs.existsSync(codexTemplate));
ok('codex: commit-msg template is verbatim (not converted)',
  fs.readFileSync(codexTemplate, 'utf8') === fs.readFileSync(path.join(repoRoot, 'plugins', 'trailhead', 'templates', 'trailhead-commit-msg'), 'utf8'));

ok('codex: no agents dir', !fs.existsSync(path.join(codexDir, 'agents')));
ok('codex: no settings.json file', !fs.existsSync(path.join(codexDir, 'settings.json')));

// --- codex uninstall (same tmp) ----------------------------------------------
runInstaller([`--codex`, `--dir=${codexDir}`, '--uninstall']);
ok('codex uninstall: trailhead-work.md gone', !fs.existsSync(path.join(codexDir, 'prompts', 'trailhead-work.md')));
ok('codex uninstall: trailhead dir gone', !fs.existsSync(path.join(codexDir, 'trailhead')));

// --- claude regression --------------------------------------------------------
const claudeDir = mktmp();
runInstaller([`--claude`, `--dir=${claudeDir}`]);

ok('claude: skills/trailhead/SKILL.md exists', fs.existsSync(path.join(claudeDir, 'skills', 'trailhead', 'SKILL.md')));
ok('claude: commands/trailhead/work.md exists', fs.existsSync(path.join(claudeDir, 'commands', 'trailhead', 'work.md')));
ok('claude: hooks/trailhead-commit-guard.js exists', fs.existsSync(path.join(claudeDir, 'hooks', 'trailhead-commit-guard.js')));

const settingsPath = path.join(claudeDir, 'settings.json');
ok('claude: settings.json exists', fs.existsSync(settingsPath));
const settingsContent = fs.readFileSync(settingsPath, 'utf8');
ok('claude: settings.json references commit-guard', settingsContent.includes('trailhead-commit-guard.js'));

// --- auto-detect: exactly one CLI on $PATH -> install for it, no flag ----------
// Only a fake `codex` on $PATH: the installer must pick codex on its own.
const autoCodexDir = mktmp();
runInstaller([`--dir=${autoCodexDir}`], { env: { PATH: fakeBinDir(['codex']) } });
ok('auto-detect codex: bare trailhead.md prompt exists', fs.existsSync(path.join(autoCodexDir, 'prompts', 'trailhead.md')));
ok('auto-detect codex: did not install the Claude layout', !fs.existsSync(path.join(autoCodexDir, 'skills', 'trailhead', 'SKILL.md')));

// Only a fake `claude` on $PATH: the installer must pick claude on its own.
const autoClaudeDir = mktmp();
runInstaller([`--dir=${autoClaudeDir}`], { env: { PATH: fakeBinDir(['claude']) } });
ok('auto-detect claude: skills/trailhead/SKILL.md exists', fs.existsSync(path.join(autoClaudeDir, 'skills', 'trailhead', 'SKILL.md')));

// --- auto-detect: ambiguous + non-interactive -> claude fallback --------------
// No CLI on $PATH and non-interactive (piped stdio): must fall back to claude.
const fallbackDir = mktmp();
runInstaller([`--dir=${fallbackDir}`], { env: { PATH: fakeBinDir([]) } });
ok('ambiguous fallback: installs the Claude layout', fs.existsSync(path.join(fallbackDir, 'skills', 'trailhead', 'SKILL.md')));

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
ok('legacy --host=codex is ignored (auto-detect wins)', fs.existsSync(path.join(legacyDir, 'skills', 'trailhead', 'SKILL.md')));

// --- cleanup -------------------------------------------------------------------
for (const d of tmpDirs) {
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`✓ trailhead.js (installer): ${passed} assertions passed`);
