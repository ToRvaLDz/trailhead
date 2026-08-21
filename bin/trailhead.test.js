#!/usr/bin/env node
// Integration tests for trailhead.js (the installer). Run: node trailhead.test.js
// No framework: plain asserts, mirrors the style of host-descriptor.test.js.
// Drives the real CLI via child_process against fresh temp dirs, always
// passing --host= and --dir= explicitly so no TTY prompt can fire.
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

function runInstaller(extraArgs) {
  execFileSync('node', [installerPath, ...extraArgs], { cwd: repoRoot, stdio: 'pipe' });
}

// --- codex install -----------------------------------------------------------
const codexDir = mktmp();
runInstaller([`--host=codex`, `--dir=${codexDir}`]);

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

ok('codex: no agents dir', !fs.existsSync(path.join(codexDir, 'agents')));
ok('codex: no settings.json file', !fs.existsSync(path.join(codexDir, 'settings.json')));

// --- codex uninstall (same tmp) ----------------------------------------------
runInstaller([`--host=codex`, `--dir=${codexDir}`, '--uninstall']);
ok('codex uninstall: trailhead-work.md gone', !fs.existsSync(path.join(codexDir, 'prompts', 'trailhead-work.md')));
ok('codex uninstall: trailhead dir gone', !fs.existsSync(path.join(codexDir, 'trailhead')));

// --- claude regression --------------------------------------------------------
const claudeDir = mktmp();
runInstaller([`--host=claude`, `--dir=${claudeDir}`]);

ok('claude: skills/trailhead/SKILL.md exists', fs.existsSync(path.join(claudeDir, 'skills', 'trailhead', 'SKILL.md')));
ok('claude: commands/trailhead/work.md exists', fs.existsSync(path.join(claudeDir, 'commands', 'trailhead', 'work.md')));
ok('claude: hooks/trailhead-commit-guard.js exists', fs.existsSync(path.join(claudeDir, 'hooks', 'trailhead-commit-guard.js')));

const settingsPath = path.join(claudeDir, 'settings.json');
ok('claude: settings.json exists', fs.existsSync(settingsPath));
const settingsContent = fs.readFileSync(settingsPath, 'utf8');
ok('claude: settings.json references commit-guard', settingsContent.includes('trailhead-commit-guard.js'));

// --- cleanup -------------------------------------------------------------------
for (const d of tmpDirs) {
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`✓ trailhead.js (installer): ${passed} assertions passed`);
