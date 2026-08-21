#!/usr/bin/env node
// Tests for host-descriptor.js. Run: node host-descriptor.test.js
// No framework: plain asserts, mirrors the style of trailhead-secret-guard.test.js.
const assert = require('assert');
const {
  AXES,
  HOSTS,
  getHost,
  configDirFor,
  hyphenateCommand,
  emitsAgentToml,
  degradations,
  modelsCollapseNotice,
  updateNotice,
  detectHost,
} = require('./host-descriptor.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- AXES ---
ok('AXES is frozen', Object.isFrozen(AXES));
ok('AXES.commandSurface is frozen and correct', Object.isFrozen(AXES.commandSurface) &&
  AXES.commandSurface.length === 2 &&
  AXES.commandSurface.includes('slash-file') && AXES.commandSurface.includes('hyphen-prompt'));
ok('AXES.subagentToolkit is frozen and correct', Object.isFrozen(AXES.subagentToolkit) &&
  AXES.subagentToolkit.length === 2 &&
  AXES.subagentToolkit.includes('full') && AXES.subagentToolkit.includes('none'));
ok('AXES.hookBus is frozen and correct', Object.isFrozen(AXES.hookBus) &&
  AXES.hookBus.length === 2 &&
  AXES.hookBus.includes('host') && AXES.hookBus.includes('none'));

// --- getHost ---
const claude = getHost('claude');
const codex = getHost('codex');
ok('getHost(claude) has correct axes', claude.axes.commandSurface === 'slash-file' &&
  claude.axes.subagentToolkit === 'full' && claude.axes.hookBus === 'host');
ok('getHost(codex) has correct axes', codex.axes.commandSurface === 'hyphen-prompt' &&
  codex.axes.subagentToolkit === 'none' && codex.axes.hookBus === 'none');
assert.throws(() => getHost('gemini'), /gemini/i, 'getHost(gemini) throws naming the unknown host');
ok('getHost(gemini) throws', (() => {
  try { getHost('gemini'); return false; } catch { return true; }
})());
// Inherited prototype keys are not hosts: getHost must throw, not hand back an
// Object.prototype member (own-property check, not a bare index truthiness test).
ok('getHost(toString) throws (no prototype-chain leak)', (() => {
  try { getHost('toString'); return false; } catch { return true; }
})());
ok('getHost(constructor) throws (no prototype-chain leak)', (() => {
  try { getHost('constructor'); return false; } catch { return true; }
})());

// --- frozen descriptors ---
ok('getHost(codex) descriptor is frozen', Object.isFrozen(codex));
ok('getHost(claude) descriptor is frozen', Object.isFrozen(claude));
ok('HOSTS is frozen', Object.isFrozen(HOSTS));

// --- emitsAgentToml ---
ok('emitsAgentToml(claude) === false', emitsAgentToml('claude') === false);
ok('emitsAgentToml(codex) === false', emitsAgentToml('codex') === false);

// --- hyphenateCommand ---
ok('hyphenateCommand strips leading slash and replaces colon', hyphenateCommand('/trailhead:work') === 'trailhead-work');
ok('hyphenateCommand handles no leading slash', hyphenateCommand('trailhead:work') === 'trailhead-work');
ok('hyphenateCommand handles no colon', hyphenateCommand('/trailhead') === 'trailhead');

// --- configDirFor ---
ok('configDirFor(claude) uses env override', configDirFor('claude', { env: { CLAUDE_CONFIG_DIR: '/x/y' }, homedir: '/home/u' }) === '/x/y');
ok('configDirFor(claude) falls back to homedir default', configDirFor('claude', { env: {}, homedir: '/home/u' }).endsWith('/home/u/.claude') ||
  configDirFor('claude', { env: {}, homedir: '/home/u' }) === require('path').join('/home/u', '.claude'));
ok('configDirFor(codex) falls back to homedir default', configDirFor('codex', { env: {}, homedir: '/home/u' }) === require('path').join('/home/u', '.codex'));

// --- degradations ---
ok('degradations(claude) is empty', Array.isArray(degradations('claude')) && degradations('claude').length === 0);
ok('degradations(codex) is non-empty', Array.isArray(degradations('codex')) && degradations('codex').length > 0);

// --- modelsCollapseNotice ---
ok('modelsCollapseNotice(claude, models set) is null (has toolkit)',
  modelsCollapseNotice('claude', { models: { execute: 'claude-sonnet-5' } }) === null);
ok('modelsCollapseNotice(codex, no models) is null',
  modelsCollapseNotice('codex', {}) === null);
ok('modelsCollapseNotice(codex, empty models) is null',
  modelsCollapseNotice('codex', { models: {} }) === null);
ok('modelsCollapseNotice(codex, nullish/empty values) is null',
  modelsCollapseNotice('codex', { models: { plan: '', execute: null } }) === null);
ok('modelsCollapseNotice(codex, models set) names the set keys', (() => {
  const msg = modelsCollapseNotice('codex', { models: { plan: 'x', execute: 'y' } });
  return typeof msg === 'string' && msg.includes('plan') && msg.includes('execute') && msg.includes('Codex');
})());
ok('modelsCollapseNotice(codex, undefined config) is null',
  modelsCollapseNotice('codex') === null);

// --- updateNotice ---
ok('updateNotice(codex, update available) is a non-null string naming the version', (() => {
  const msg = updateNotice('codex', { updateAvailable: true, latest: '0.3.0', installed: '0.2.0' });
  return typeof msg === 'string' && msg.includes('0.3.0');
})());
ok('updateNotice(codex, no update available) is null',
  updateNotice('codex', { updateAvailable: false }) === null);
ok('updateNotice(codex, null cache) is null',
  updateNotice('codex', null) === null);
ok('updateNotice(claude, update available) is null (claude has a hook bus)',
  updateNotice('claude', { updateAvailable: true, latest: '0.3.0' }) === null);

// --- detectHost ---
ok('detectHost: CODEX_SANDBOX signals codex', detectHost({ env: { CODEX_SANDBOX: 'seatbelt' } }) === 'codex');
ok('detectHost: CODEX_SANDBOX_NETWORK_DISABLED signals codex', detectHost({ env: { CODEX_SANDBOX_NETWORK_DISABLED: '1' } }) === 'codex');
ok('detectHost: CODEX_HOME with marker file signals codex', detectHost({
  env: { CODEX_HOME: '/c' },
  fileExists: (p) => p === '/c/config.toml',
}) === 'codex');
ok('detectHost: CODEX_HOME without marker file falls back to claude', detectHost({
  env: { CODEX_HOME: '/c' },
  fileExists: () => false,
}) === 'claude');
ok('detectHost: no signals falls back to claude', detectHost({ env: {} }) === 'claude');
ok('detectHost: never throws, degrades to claude', detectHost({
  env: new Proxy({}, { get() { throw new Error('boom'); } }),
}) === 'claude');

console.log(`✓ host-descriptor: ${passed} assertions passed`);
