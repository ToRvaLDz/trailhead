#!/usr/bin/env node
// Tests for templates/statusline-trailhead.sh (barra contesto, --context-only).
// Run: node statusline-context.test.js
// No framework: plain asserts, same style as work-state.test.js.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const script = path.resolve(__dirname, '..', '..', 'templates', 'statusline-trailhead.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-statusline-ctx-'));
const home = path.join(root, 'home');
const cfg = path.join(root, 'cfg');
const proj = path.join(root, 'proj');
for (const d of [home, cfg, path.join(proj, '.claude')]) fs.mkdirSync(d, { recursive: true });

const SETTINGS = {
  user: path.join(cfg, 'settings.json'),
  project: path.join(proj, '.claude', 'settings.json'),
  local: path.join(proj, '.claude', 'settings.local.json'),
};

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, got, want) => { assert.strictEqual(got, want, `${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); passed++; };

function setSettings(files) {
  for (const f of Object.values(SETTINGS)) fs.rmSync(f, { force: true });
  for (const [k, v] of Object.entries(files || {})) {
    fs.writeFileSync(SETTINGS[k], typeof v === 'string' ? v : JSON.stringify(v));
  }
}

// Esegue lo script e ritorna { pct, shown, out }
function ctx(tok, { env = {}, settings = {}, modelId = 'claude-opus-5-5[1m]', size = 1000000 } = {}) {
  setSettings(settings);
  const base = { ...process.env };
  for (const k of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CONTEXT_LIMIT', 'CONTEXT_USABLE_RATIO']) delete base[k];
  const input = {
    model: { id: modelId, display_name: 'Test' },
    workspace: { project_dir: proj, current_dir: proj },
    context_window: { context_window_size: size, current_usage: { input_tokens: tok } },
  };
  const r = spawnSync('bash', [script, '--context-only'], {
    input: JSON.stringify(input),
    env: { ...base, NO_COLOR: '1', TRAILHEAD_STATUSLINE_USAGE: '0', HOME: home, CLAUDE_CONFIG_DIR: cfg, ...env },
    encoding: 'utf8',
  });
  const out = r.stdout.trim();
  const m = out.match(/^\[.{10}\] (\d+)k\/(\d+)k \((\d+)%\)$/);
  assert.ok(m, `unexpected output: ${JSON.stringify(out)} ${r.stderr}`);
  return { pct: Number(m[3]), shown: `${m[1]}k/${m[2]}k`, out };
}
const pct = (tok, o) => ctx(tok, o).pct;

// --- default 1M: soglia = 1M - 33k = 967k ---
eq('default 966k', pct(966000), 100);
eq('default 967k', pct(967000), 100);
eq('default 900k', pct(900000), 93);
ok('default 800k not 100', pct(800000) < 100);
eq('display full window', ctx(900000).shown, '900k/1000k');

// --- autoCompactWindow ---
const win650 = { autoCompactWindow: 650000 };
eq('top-level 617k', pct(617000, { settings: { user: win650 } }), 100);
ok('top-level 600k', pct(600000, { settings: { user: win650 } }) < 100);
const perModel = { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 650000 } } };
eq('per-model 617k', pct(617000, { settings: { user: perModel } }), 100);
ok('per-model 600k', pct(600000, { settings: { user: perModel } }) < 100);
eq('per-model beats top-level', pct(617000, {
  settings: { user: { autoCompactWindow: 900000, ...perModel } } }), 100);
eq('per-model beats top-level (larger top)', pct(300000, {
  settings: { user: { autoCompactWindow: 400000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 1000000 } } } } }), 31);
eq('local beats user', pct(617000, { settings: { user: { autoCompactWindow: 1000000 }, local: win650 } }), 100);
eq('local beats project', pct(617000, { settings: { project: { autoCompactWindow: 1000000 }, local: win650 } }), 100);
eq('project beats user', pct(617000, { settings: { user: { autoCompactWindow: 1000000 }, project: win650 } }), 100);
eq('invalid json skipped', pct(617000, { settings: { user: win650, local: '{nope' } }), 100);
eq('non-positive setting ignored', pct(900000, { settings: { user: { autoCompactWindow: -5 } } }), 93);
eq('non-numeric setting ignored', pct(900000, { settings: { user: { autoCompactWindow: 'big' } } }), 93);
eq('invalid higher file value falls to lower', pct(617000, {
  settings: { user: win650, local: { autoCompactWindow: 'x' } } }), 100);

// --- env CLAUDE_CODE_AUTO_COMPACT_WINDOW ---
eq('env beats setting', pct(617000, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '650000' },
  settings: { user: { autoCompactWindow: 1000000 } } }), 100);
for (const bad of ['abc', '0', '-100']) {
  eq(`env ${bad} ignored`, pct(900000, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: bad } }), 93);
}
eq('env bad falls back to setting', pct(617000, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'abc' },
  settings: { user: win650 } }), 100);
eq('window above model capped', pct(966000, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '5000000' } }), 100);
eq('window above model capped 900k', pct(900000, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '5000000' } }), 93);

// --- CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ---
eq('pct 50 at threshold', pct(500000, { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } }), 100);
eq('pct 50 at 450k', pct(450000, { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } }), 90);
for (const v of ['100', '101', '0', '-3', 'abc']) {
  eq(`pct ${v} no change`, pct(900000, { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: v } }), 93);
}
eq('pct 1 -> threshold 10k', pct(10000, { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' } }), 100);
eq('pct 1 at 5k', pct(5000, { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' } }), 50);

// --- disabilitato ---
eq('DISABLE_AUTO_COMPACT', pct(400000, { env: { DISABLE_AUTO_COMPACT: '1' } }), 40);
eq('DISABLE_COMPACT true', pct(400000, { env: { DISABLE_COMPACT: 'TRUE' } }), 40);
eq('disabled ignores settings and pct', pct(400000, { env: { DISABLE_AUTO_COMPACT: 'yes', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '10' },
  settings: { user: win650 } }), 40);
eq('falsy DISABLE ignored', pct(900000, { env: { DISABLE_AUTO_COMPACT: '0' } }), 93);
eq('DISABLE_COMPACT on', pct(400000, { env: { DISABLE_COMPACT: 'on' } }), 40);
eq('DISABLE false ignored', pct(900000, { env: { DISABLE_COMPACT: 'false' } }), 93);

// --- per-modello in un file meno specifico batte top-level in uno piu' specifico ---
eq('per-model user beats top-level local', pct(617000, {
  settings: { user: perModel, local: { autoCompactWindow: 1000000 } } }), 100);

// --- fallback tabella modello (niente context_window_size): 200k, soglia 167k ---
eq('model table fallback', pct(100000, { size: 0 }), 60);
eq('model table fallback display', ctx(100000, { size: 0 }).shown, '100k/200k');

// --- tetto modello ---
eq('CONTEXT_LIMIT caps display', ctx(100000, { env: { CONTEXT_LIMIT: '200000' } }).shown, '100k/200k');
eq('CONTEXT_LIMIT pct (threshold 167k)', pct(100000, { env: { CONTEXT_LIMIT: '200000' } }), 60);

// --- override manuale CONTEXT_USABLE_RATIO ---
eq('ratio 0.8 old behaviour', pct(800000, { env: { CONTEXT_USABLE_RATIO: '0.8' } }), 100);
eq('ratio 0.8 at 400k', pct(400000, { env: { CONTEXT_USABLE_RATIO: '0.8' } }), 50);
eq('ratio bypasses window setting', pct(400000, { env: { CONTEXT_USABLE_RATIO: '0.8' }, settings: { user: win650 } }), 50);
eq('ratio invalid ignored', pct(900000, { env: { CONTEXT_USABLE_RATIO: '2' } }), 93);

// --- bordo soglia: finestra 34k -> soglia 1000 ---
const edge = { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '34000' } };
eq('edge threshold-1', pct(994, edge), 99);
eq('edge threshold', pct(1000, edge), 100);
// finestra minuscola: soglia mai sotto 1
eq('tiny window guard', pct(5, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '10' } }), 100);

fs.rmSync(root, { recursive: true, force: true });
console.log(`statusline-context.test.js: ${passed} assertions passed`);
