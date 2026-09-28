#!/usr/bin/env node
// Tests for install-verify.js. Run: node install-verify.test.js
// No framework: plain asserts, mirrors the style of codex-projection.test.js.
// Fixtures live under os.tmpdir(); every spec passes an explicit env/home,
// never the real process.env/os.homedir(), so the tests stay hermetic.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sharedCoreFiles,
  hookScriptTokens,
  expandTarget,
  verifyInstall,
  claudeVerifySpec,
  codexVerifySpec,
  formatVerifyFailure,
  formatVerifyWarnings,
} = require('./install-verify.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const tmpDirs = [];
function mktmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'th-iv-'));
  tmpDirs.push(d);
  return d;
}
function write(p, content = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// --- sharedCoreFiles -----------------------------------------------------------
const loadFirstPath = path.join(__dirname, '../../plugins/trailhead/skills/_shared/load-first.md');
const loadFirstSrc = fs.readFileSync(loadFirstPath, 'utf8');
ok('sharedCoreFiles on the real load-first.md returns the 7 core names',
  JSON.stringify(sharedCoreFiles(loadFirstSrc)) === JSON.stringify([
    'load-first.md', 'principles.md', 'ticket-language.md', 'substrate.md',
    'session-handoff.md', 'configuration.md', 'techniques.md',
  ]));
ok("sharedCoreFiles('') returns just load-first.md", JSON.stringify(sharedCoreFiles('')) === JSON.stringify(['load-first.md']));
ok('sharedCoreFiles de-duplicates repeated entries', JSON.stringify(sharedCoreFiles(
  '1. `../_shared/a.md`: x\n2. `../_shared/a.md`: x again\n3. `../_shared/b.md`: y\n'
)) === JSON.stringify(['load-first.md', 'a.md', 'b.md']));

// --- hookScriptTokens ----------------------------------------------------------
ok('hookScriptTokens: node "<p>"', JSON.stringify(hookScriptTokens('node "/x/trailhead-a.js"')) === JSON.stringify(['/x/trailhead-a.js']));
ok('hookScriptTokens: node <p>', JSON.stringify(hookScriptTokens('node /x/trailhead-a.js')) === JSON.stringify(['/x/trailhead-a.js']));
ok('hookScriptTokens: node <p> --flag', JSON.stringify(hookScriptTokens('node /x/trailhead-a.js --flag')) === JSON.stringify(['/x/trailhead-a.js']));
ok("hookScriptTokens: bash -c 'node <p>'", JSON.stringify(hookScriptTokens("bash -c 'node /x/trailhead-a.js'")) === JSON.stringify(['/x/trailhead-a.js']));
ok("hookScriptTokens: /usr/bin/env node '<p>'", JSON.stringify(hookScriptTokens("/usr/bin/env node '/x/trailhead-a.js'")) === JSON.stringify(['/x/trailhead-a.js']));
ok('hookScriptTokens: no trailhead script gives []', JSON.stringify(hookScriptTokens('node /x/other.js')) === JSON.stringify([]));
ok('hookScriptTokens: trailhead-x.json does not match', JSON.stringify(hookScriptTokens('node /x/trailhead-x.json')) === JSON.stringify([]));
ok('hookScriptTokens: my-trailhead-x.js does not match', JSON.stringify(hookScriptTokens('node /x/my-trailhead-x.js')) === JSON.stringify([]));

// --- expandTarget ----------------------------------------------------------------
const H = '/home/fixture-user';
ok('expandTarget ~/a becomes home', expandTarget('~/a', { env: {}, home: H }).path === path.join(H, 'a'));
ok('expandTarget ~ alone becomes home', expandTarget('~', { env: {}, home: H }).path === H);
ok('expandTarget $A/x expands with A defined', expandTarget('$A/x', { env: { A: '/v' }, home: H }).path === '/v/x');
ok('expandTarget ${A}/x expands with A defined', expandTarget('${A}/x', { env: { A: '/v' }, home: H }).path === '/v/x');
ok('expandTarget undefined ${CLAUDE_PLUGIN_ROOT} is unresolved',
  expandTarget('${CLAUDE_PLUGIN_ROOT}/x', { env: {}, home: H }).unresolved === 'CLAUDE_PLUGIN_ROOT');
ok('expandTarget substitutes an empty-string variable', expandTarget('$A/x', { env: { A: '' }, home: H }).path === '/x');

// --- verifyInstall: clean fixtures ----------------------------------------------
function buildClaudeFixture() {
  const configDir = mktmp();
  const skillDirs = ['trailhead', '_shared', 'trailhead-work'];
  const sharedFiles = ['load-first.md', 'substrate.md'];
  const hookFiles = ['trailhead-commit-guard.js', 'trailhead-body-guard.js'];
  const hookLibFiles = ['commit-message-check.js'];
  write(path.join(configDir, 'skills', 'trailhead', 'SKILL.md'), 'x');
  write(path.join(configDir, 'skills', 'trailhead-work', 'SKILL.md'), 'x');
  write(path.join(configDir, 'skills', '_shared', 'load-first.md'), 'x');
  write(path.join(configDir, 'skills', '_shared', 'substrate.md'), 'x');
  write(path.join(configDir, 'hooks', 'trailhead-commit-guard.js'), 'x');
  write(path.join(configDir, 'hooks', 'trailhead-body-guard.js'), 'x');
  write(path.join(configDir, 'hooks', 'lib', 'commit-message-check.js'), 'x');
  write(path.join(configDir, 'agents', 'trailhead-execute.md'), 'x');
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
        { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      ] }],
    },
  };
  write(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  const spec = claudeVerifySpec(configDir, { skillDirs, sharedFiles, hookFiles, hookLibFiles, env: {}, home: H });
  return { configDir, spec, skillDirs, sharedFiles, hookFiles, hookLibFiles };
}

function buildCodexFixture() {
  const configDir = mktmp();
  const skillDirs = ['trailhead', '_shared', 'trailhead-work'];
  const sharedFiles = ['load-first.md', 'substrate.md'];
  const hookFiles = ['trailhead-commit-guard.js', 'trailhead-body-guard.js'];
  const hookLibFiles = ['commit-message-check.js'];
  const hooksScriptsDir = path.join(configDir, 'skills', 'trailhead', 'hooks');
  write(path.join(configDir, 'skills', 'trailhead', 'SKILL.md'), 'x');
  write(path.join(configDir, 'skills', 'trailhead-work', 'SKILL.md'), 'x');
  write(path.join(configDir, 'skills', '_shared', 'load-first.md'), 'x');
  write(path.join(configDir, 'skills', '_shared', 'substrate.md'), 'x');
  write(path.join(hooksScriptsDir, 'trailhead-commit-guard.js'), 'x');
  write(path.join(hooksScriptsDir, 'trailhead-body-guard.js'), 'x');
  write(path.join(hooksScriptsDir, 'lib', 'commit-message-check.js'), 'x');
  write(path.join(configDir, 'agents', 'trailhead-execute.toml'), 'x');
  const hooksJson = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: `node "${path.join(hooksScriptsDir, 'trailhead-commit-guard.js')}"` },
        { type: 'command', command: `node "${path.join(hooksScriptsDir, 'trailhead-body-guard.js')}"` },
      ] }],
    },
  };
  write(path.join(configDir, 'hooks.json'), JSON.stringify(hooksJson, null, 2));
  const spec = codexVerifySpec(configDir, { skillDirs, sharedFiles, hookFiles, hookLibFiles, env: {}, home: H });
  return { configDir, spec, skillDirs, sharedFiles, hookFiles, hookLibFiles, hooksScriptsDir };
}

{
  const { spec } = buildClaudeFixture();
  const r = verifyInstall(spec);
  ok('verifyInstall claude clean fixture: no missing/unverified', r.missing.length === 0 && r.unverified.length === 0);
}
{
  const { spec } = buildCodexFixture();
  const r = verifyInstall(spec);
  ok('verifyInstall codex clean fixture: no missing/unverified', r.missing.length === 0 && r.unverified.length === 0);
}
// The Codex spec never flags search-guard (it is never in hookFiles for Codex).
{
  const { spec } = buildCodexFixture();
  const r = verifyInstall(spec);
  ok('verifyInstall codex spec never names search-guard',
    !r.missing.some((m) => m.includes('search-guard')) && !r.unverified.some((u) => u.includes('search-guard')));
}

// --- verifyInstall: one named `missing` entry each ------------------------------
{
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'hooks', 'trailhead-body-guard.js'));
  const r = verifyInstall(spec);
  ok('missing: a missing hook file', r.missing.includes('hook script trailhead-body-guard.js'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'hooks', 'trailhead-body-guard.js'));
  fs.mkdirSync(path.join(configDir, 'hooks', 'trailhead-body-guard.js'), { recursive: true });
  const r = verifyInstall(spec);
  ok('missing: a hook path that is a directory', r.missing.includes('hook script trailhead-body-guard.js'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'hooks', 'lib', 'commit-message-check.js'));
  const r = verifyInstall(spec);
  ok('missing: a missing lib file', r.missing.includes('hook lib lib/commit-message-check.js'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('missing: an unregistered hook', r.missing.includes('hook registration trailhead-body-guard.js (settings.json)'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: 'node "/other/dir/trailhead-body-guard.js"' },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('missing: a lookalike registration at /other/dir/trailhead-commit-guard.js is still unregistered',
    r.missing.includes('hook registration trailhead-body-guard.js (settings.json)') &&
    r.missing.includes('registered hook target /other/dir/trailhead-body-guard.js (PreToolUse, settings.json)'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'agents', 'trailhead-execute.md'));
  write(path.join(configDir, 'agents', 'my-custom-agent.md'), 'x');
  const r = verifyInstall(spec);
  ok('missing: zero agents, with a non-trailhead agent present', r.missing.some((m) => m.startsWith('agents: no trailhead-* agents')));
}
{
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'skills', 'trailhead-work', 'SKILL.md'));
  const r = verifyInstall(spec);
  ok('missing: a cluster with no SKILL.md', r.missing.includes('skill trailhead-work/SKILL.md'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'skills', '_shared'), { recursive: true, force: true });
  const r = verifyInstall(spec);
  ok('missing: _shared missing', r.missing.includes('shared core _shared/load-first.md') && r.missing.includes('shared core _shared/substrate.md'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'skills', '_shared', 'substrate.md'));
  const r = verifyInstall(spec);
  ok('missing: _shared present without substrate.md', r.missing.includes('shared core _shared/substrate.md') && !r.missing.includes('shared core _shared/load-first.md'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  const dangling = path.join(configDir, 'hooks', 'trailhead-body-guard.js');
  fs.rmSync(dangling);
  fs.symlinkSync(path.join(configDir, 'nonexistent-target.js'), dangling);
  const r = verifyInstall(spec);
  ok('missing: a dangling symlink', r.missing.includes('hook script trailhead-body-guard.js'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-old-guard.js')}"` },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('missing: a stale trailhead-old-guard.js registration',
    r.missing.includes(`registered hook target ${path.join(configDir, 'hooks', 'trailhead-old-guard.js')} (PreToolUse, settings.json)`));
}
{
  const { configDir, spec } = buildClaudeFixture();
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      { type: 'command', command: 'node hooks/trailhead-x-guard.js' },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('missing: a relative target', r.missing.includes('registered hook target hooks/trailhead-x-guard.js is relative (PreToolUse, settings.json)'));
}
{
  const { configDir, spec } = buildClaudeFixture();
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      { type: 'command', command: 'node "~/gone/trailhead-x-guard.js"' },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('missing: a ~/gone/trailhead-x-guard.js target (expands under the fixture home, not found)',
    r.missing.includes(`registered hook target ${path.join(H, 'gone', 'trailhead-x-guard.js')} (PreToolUse, settings.json)`));
}
{
  const { configDir, spec } = buildClaudeFixture();
  spec.env = { A: configDir };
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      { type: 'command', command: 'node "$A/trailhead-x-guard.js"' },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('missing: a $A/trailhead-x-guard.js target with A defined but the file absent',
    r.missing.includes(`registered hook target ${path.join(configDir, 'trailhead-x-guard.js')} (PreToolUse, settings.json)`));
}
{
  const { configDir, spec } = buildClaudeFixture();
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      { type: 'command', command: `bash -c 'node "${path.join(configDir, 'hooks', 'trailhead-gone.js')}"'` },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok("missing: a script inside bash -c '...' whose file is gone",
    r.missing.includes(`registered hook target ${path.join(configDir, 'hooks', 'trailhead-gone.js')} (PreToolUse, settings.json)`));
}

// --- verifyInstall: resolution cases ---------------------------------------------
{
  const { configDir, spec } = buildClaudeFixture();
  spec.env = {};
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ matcher: '', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/trailhead-x.js"' },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('resolution: undefined ${CLAUDE_PLUGIN_ROOT} gives missing: [] plus one unverified entry naming the variable',
    r.missing.length === 0 && r.unverified.some((u) => u.includes('CLAUDE_PLUGIN_ROOT undefined')));
}
{
  // ~/... and $A/... pointing at EXISTING fixture files both pass.
  const { configDir, spec } = buildClaudeFixture();
  const homeDir = mktmp();
  spec.home = homeDir;
  spec.env = { A: configDir };
  write(path.join(homeDir, 'sub', 'trailhead-tilde.js'), 'x');
  write(path.join(configDir, 'trailhead-dollar.js'), 'x');
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      { type: 'command', command: 'node "~/sub/trailhead-tilde.js"' },
      { type: 'command', command: 'node "$A/trailhead-dollar.js"' },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('resolution: ~/... and $A/... pointing at existing fixture files pass (no new missing/unverified)',
    r.missing.length === 0 && r.unverified.length === 0);
}
{
  // A non-trailhead hook with a missing target is ignored entirely.
  const { configDir, spec } = buildClaudeFixture();
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-body-guard.js')}"` },
      { type: 'command', command: 'node "/gone/other.js"' },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('resolution: a non-trailhead hook with a missing target is ignored', r.missing.length === 0 && r.unverified.length === 0);
}
{
  // Missing/malformed registry: no crash, every expected hook unregistered.
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'settings.json'));
  const r1 = verifyInstall(spec);
  ok('resolution: a missing registry file does not crash and flags every hook unregistered',
    r1.missing.includes('hook registration trailhead-commit-guard.js (settings.json)') &&
    r1.missing.includes('hook registration trailhead-body-guard.js (settings.json)'));
  write(path.join(configDir, 'settings.json'), '{not json');
  const r2 = verifyInstall(spec);
  ok('resolution: a malformed registry file does not crash and flags every hook unregistered',
    r2.missing.includes('hook registration trailhead-commit-guard.js (settings.json)'));
}

// --- A2: unresolved expected registration stays warning-only ---------------------
{
  const { configDir, spec } = buildClaudeFixture();
  fs.rmSync(path.join(configDir, 'hooks', 'trailhead-body-guard.js'));
  write(path.join(configDir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `node "${path.join(configDir, 'hooks', 'trailhead-commit-guard.js')}"` },
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/trailhead-body-guard.js"' },
    ] }] },
  }));
  const r = verifyInstall(spec);
  ok('A2: an unresolved token whose basename matches the expected file stays unverified, not also missing',
    !r.missing.includes('hook registration trailhead-body-guard.js (settings.json)') &&
    r.unverified.some((u) => u.includes('CLAUDE_PLUGIN_ROOT undefined')));
}

// --- formatters --------------------------------------------------------------
{
  const out = formatVerifyFailure('Claude Code', '/c/dir', { missing: ['skill trailhead-work/SKILL.md'], unverified: ['/x/trailhead-y.js (PreToolUse, settings.json: $Y undefined)'] });
  ok('formatVerifyFailure contains the host', out.includes('Claude Code'));
  ok('formatVerifyFailure contains the dir', out.includes('/c/dir'));
  ok('formatVerifyFailure contains the missing entry', out.includes('skill trailhead-work/SKILL.md'));
  ok('formatVerifyFailure contains the unverified entry', out.includes('$Y undefined'));
}
ok('formatVerifyWarnings([]) is []', JSON.stringify(formatVerifyWarnings([])) === '[]');
ok('formatVerifyWarnings has one line per entry', (() => {
  const lines = formatVerifyWarnings(['a', 'b']);
  return lines.length === 2 && lines[0].includes('⚠') && lines[0].includes('a') && lines[1].includes('b');
})());

// --- cleanup ---------------------------------------------------------------
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });

console.log(`✓ install-verify: ${passed} assertions passed`);
