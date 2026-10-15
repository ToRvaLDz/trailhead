#!/usr/bin/env node
// Docs test for #252: the skill prose wires the UAT setup step into every UAT start
// (after the stale-base preflight, before the drive-mode ask) and documents the
// uat.setup / uat.accounts config keys.
// Run: node uat-setup-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const HELPER = 'trailhead-uat-setup.js';
const EXPECT = {
  '_shared/techniques/acceptance-testing.md': [
    '**UAT setup comes next.**', HELPER, '`uat.setup`', '`uat.accounts`', '`unconfigured`', '`invalid`', 'retry', 'treat as a defect', 'Never a silent fallback',
    'never a value', 'step names and results only', 'declined again, it is not re-offered this session', '--config-root',
  ],
  '_shared/configuration-reference.md': [
    '| `uat.setup` |', '| `uat.accounts` |', '**UAT setup.**', '`missing-env`', 'References, never values', 'the nested form wins', '`testing.webapp` / `testing.url` are unchanged',
    '**🧰 UAT setup**', '**👤 Test account**', 'never the secret\'s value',
  ],
  'trailhead-work/references/auto.md': ['**UAT setup in `auto`**', 'no probe, no proposal, no save offer', 'run-end summary'],
};
for (const [rel, needles] of Object.entries(EXPECT)) {
  const text = read(rel);
  for (const needle of needles) ok(`${rel} names: ${needle}`, text.includes(needle));
}

// In the technique: preflight bullet < setup bullet < drive-mode ask.
const tech = read('_shared/techniques/acceptance-testing.md');
const pre = tech.indexOf('- **Stale-base preflight comes first.**');
const setup = tech.indexOf('- **UAT setup comes next.**');
const ask = tech.indexOf('- **Drive mode: ask who drives the UAT.**');
ok('setup bullet sits between the preflight bullet and the drive-mode ask', pre >= 0 && pre < setup && setup < ask);
ok('setup names all three start paths', ['`build`/`bug` Verify', 'Pending-UAT guard', '`UAT of:`'].every((s) => tech.slice(setup, ask).includes(s)));

// Each engine start path names the setup after the preflight and before the drive-mode ask.
const engines = read('trailhead-work/references/ticket-engines.md');
const lines = engines.split('\n');
const step = (prefix, from = 0) => lines.findIndex((l, i) => i >= from && l.startsWith(prefix));
const buildVerify = step('4. **Verify**');
const buildResolve = step('5. **Resolve**', buildVerify + 1);
const bugVerify = step('4. **Verify**', buildResolve + 1);
for (const [name, idx] of [['build Verify', buildVerify], ['bug Verify', bugVerify]]) {
  const l = lines[idx];
  const s = l.indexOf('opening with the UAT setup');
  ok(`${name} names the UAT setup`, s >= 0);
  ok(`${name}: preflight, then setup, then the drive-mode ask`, l.indexOf('Stale-base preflight') < s && s < l.indexOf('then the drive-mode ask'));
}
ok('Pending-UAT option (a) runs preflight, setup, then the ask (build and bug)',
  engines.split('with no ticket (the stale-base preflight first, then the UAT setup, then the drive-mode ask').length === 3);
ok('UAT follow-up: preflight, then setup, then the ask',
  /starting with the stale-base preflight[^;]*, then the UAT setup \(`trailhead-uat-setup\.js`[^;]*, and then the drive-mode ask/.test(engines));

for (const rel of ['_shared/configuration-reference.md', '_shared/techniques/acceptance-testing.md', 'trailhead-work/references/ticket-engines.md', 'trailhead-work/references/auto.md']) {
  ok(`${rel} has no em-dash`, !read(rel).includes('—'));
}

console.log(`uat-setup-docs.test.js: ${passed} checks passed`);
