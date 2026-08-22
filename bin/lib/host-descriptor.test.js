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
  codexVersionGate,
  parseVersion,
  CODEX_MIN_VERSION,
  detectHost,
} = require('./host-descriptor.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- AXES ---
ok('AXES is frozen', Object.isFrozen(AXES));
ok('AXES.commandSurface is frozen and correct', Object.isFrozen(AXES.commandSurface) &&
  AXES.commandSurface.length === 3 &&
  AXES.commandSurface.includes('slash-file') && AXES.commandSurface.includes('hyphen-prompt') &&
  AXES.commandSurface.includes('skill'));
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
ok('getHost(codex) has correct axes', codex.axes.commandSurface === 'skill' &&
  codex.axes.subagentToolkit === 'full' && codex.axes.hookBus === 'host');
ok('getHost(codex).hooks.bus === "host"', codex.hooks.bus === 'host');
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
ok('emitsAgentToml(codex) === true', emitsAgentToml('codex') === true);

// --- honorsModelKeys ---
ok('claude honours models.* keys', claude.honorsModelKeys === true);
ok('codex does NOT honour models.* keys (OpenAI-only subagent registry)', codex.honorsModelKeys === false);

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
ok('degradations(codex) no longer lists subagent fan-out (it has multi_agent)',
  !degradations('codex').some((d) => /fan-out/.test(d.from)));
ok('degradations(codex) still lists the per-activity model split collapse',
  degradations('codex').some((d) => /model split/.test(d.from)));
ok('degradations(codex) no longer lists lifecycle hooks (it has a native hook bus)',
  !degradations('codex').some((d) => /lifecycle hooks/.test(d.from)));

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
ok('modelsCollapseNotice(claude, models set) is null (Claude honours the keys)',
  modelsCollapseNotice('claude', { models: { plan: 'claude-opus-5' } }) === null);
ok('modelsCollapseNotice(codex, only Claude models.* set) mentions models.codex', (() => {
  const msg = modelsCollapseNotice('codex', { models: { plan: 'x', execute: 'y' } });
  return typeof msg === 'string' && msg.includes('models.codex');
})());
ok('modelsCollapseNotice is null once models.codex.* is set even if Claude models.* also set',
  modelsCollapseNotice('codex', { models: { plan: 'claude-opus-5', codex: { plan: 'gpt-5.6-sol' } } }) === null);
ok('modelsCollapseNotice: lone codex namespace, no Claude id, is null (k !== "codex" guard)',
  modelsCollapseNotice('codex', { models: { codex: { execute: 'gpt-5.6-terra' } } }) === null);
// Exercises the k !== 'codex' guard directly: a lone codex namespace whose
// values are all blank leaves codexSet empty, so control reaches the Claude-key
// filter, where the bare `codex` object key must NOT be counted (String({}) is
// non-empty). Without the guard this returns a spurious notice instead of null.
ok('modelsCollapseNotice: lone all-blank codex namespace, no Claude id, is null (fails without the k !== "codex" guard)',
  modelsCollapseNotice('codex', { models: { codex: { plan: '' } } }) === null);
ok('modelsCollapseNotice: codex namespace with only empty/nullish values does not silence a real Claude-id notice', (() => {
  const msg = modelsCollapseNotice('codex', { models: { plan: 'claude-opus-5', codex: { plan: '' } } });
  return typeof msg === 'string' && msg.includes('plan') && !msg.includes('codex)');
})());

// --- updateNotice ---
// Both hosts now have a hook bus (hookBus !== 'none'), so updateNotice never
// fires for either: the SessionStart hook + (on Codex) its stdout
// additionalContext handle the notification instead.
ok('updateNotice(codex, update available) is null (codex has a hook bus now)',
  updateNotice('codex', { updateAvailable: true, latest: '9.9.9', installed: '0.0.1' }) === null);
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

// --- codexVersionGate (install-time floor, #27/#28) ---
ok('CODEX_MIN_VERSION is 0.145.0', CODEX_MIN_VERSION === '0.145.0');
ok('parseVersion extracts a dotted triple', (() => { const v = parseVersion('codex-cli 0.149.0-alpha'); return v[0] === 0 && v[1] === 149 && v[2] === 0; })());
ok('parseVersion returns null when absent', parseVersion('no version here') === null);
ok('codexVersionGate at the floor proceeds', codexVersionGate('0.145.0').ok === true && codexVersionGate('codex-cli 0.145.0').proceed === true);
ok('codexVersionGate above the floor proceeds cleanly', (() => { const g = codexVersionGate('0.149.0'); return g.ok === true && g.proceed === true && g.undetermined === false; })());
ok('codexVersionGate below the floor (patch) refuses', (() => { const g = codexVersionGate('0.144.1'); return g.ok === false && g.proceed === false && /below/.test(g.message); })());
ok('codexVersionGate well below the floor (minor) refuses', codexVersionGate('0.120.0').proceed === false);
ok('codexVersionGate unparseable is undetermined but proceeds (fail-open)', (() => { const g = codexVersionGate('weird output'); return g.proceed === true && g.undetermined === true && typeof g.message === 'string'; })());
ok('codexVersionGate null (codex absent) proceeds with a warning', (() => { const g = codexVersionGate(null); return g.proceed === true && g.undetermined === true && typeof g.message === 'string'; })());
ok('codexVersionGate honours an explicit higher floor', codexVersionGate('0.150.0', '0.200.0').proceed === false);
ok('codexVersionGate never throws on an unparseable floor (proceeds)', (() => { const g = codexVersionGate('0.149.0', 'not-a-version'); return g.proceed === true; })());

console.log(`✓ host-descriptor: ${passed} assertions passed`);
