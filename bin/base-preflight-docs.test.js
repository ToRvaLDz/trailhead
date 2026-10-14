#!/usr/bin/env node
// Docs test for #243: the skill prose wires the stale-base preflight into UAT and
// integration, and documents the preflight.checks config key.
// Run: node base-preflight-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const HELPER = 'trailhead-base-preflight.js';
// file -> strings it must carry
const EXPECT = {
  '_shared/teamwork.md': [
    '**Stale-base preflight.**', HELPER, '--config-root', 'preflight -> sync -> tests -> Code review -> goal check -> UAT', 'preflight -> sync -> tests -> checks -> integration', 'start of Verify',
    '`git: pr` without isolation', 'immediately before the push and PR',
    '`current`', '`synced`', '`conflict`', '`dirty`', '`unverified`', '`trunk-diverged`', '`sync-failed`', 'Fail closed',
    'right before the trunk push', 'integration target', 'non-fast-forward', 'testsRequired', 'preflight.checks',
  ],
  '_shared/configuration-reference.md': ['`preflight.checks`', '**Preflight checks.**', 'migration', 'uniq -d'],
  '_shared/techniques/acceptance-testing.md': ['Stale-base preflight comes first', HELPER, 'already ran at the start of Verify'],
  'trailhead-work/references/auto.md': ['stale-base preflight never auto-resolves', '`conflict`'],
};
for (const [rel, needles] of Object.entries(EXPECT)) {
  const text = read(rel);
  for (const needle of needles) ok(`${rel} names: ${needle}`, text.includes(needle));
}

// Each engine call site names the preflight.
const engines = read('trailhead-work/references/ticket-engines.md');
const lines = engines.split('\n');
const step = (prefix, from = 0) => lines.findIndex((l, i) => i >= from && l.startsWith(prefix));
const buildVerify = step('4. **Verify**');
const buildResolve = step('5. **Resolve**', buildVerify + 1);
const bugVerify = step('4. **Verify**', buildResolve + 1);
const bugResolve = step('5. **Resolve**', bugVerify + 1);
for (const [name, idx] of [['build Verify', buildVerify], ['build Resolve', buildResolve], ['bug Verify', bugVerify], ['bug Resolve', bugResolve]]) {
  ok(`${name} step found`, idx >= 0);
  ok(`${name} names the stale-base preflight`, lines[idx].includes('Stale-base preflight'));
}
ok('build/bug Verify start with the preflight, before the tests and Code review',
  [buildVerify, bugVerify].every((i) => {
    const l = lines[i];
    const p = l.indexOf('Stale-base preflight');
    return p >= 0 && p < l.indexOf('**Code review**') && p < l.indexOf('**Goal-backward verification**') && p < l.indexOf('**Acceptance testing**');
  }));
ok('Verify runs the tests after the sync, before the Code review',
  [buildVerify, bugVerify].every((i) => lines[i].indexOf('then re-run the tests') > 0 && lines[i].indexOf('then re-run the tests') < lines[i].indexOf('**Code review**')));
ok('Resolve names git: pr without isolation',
  [buildResolve, bugResolve].every((i) => lines[i].includes('`git: pr` without isolation: on the ticket branch, immediately before the push and PR')));
ok('Resolve runs it before the Pending-UAT guard',
  [buildResolve, bugResolve].every((i) => lines[i].indexOf('Stale-base preflight') < lines[i].indexOf('Pending-UAT guard')));
ok('Pending-UAT option (a) runs the preflight first',
  engines.split('with no ticket (the stale-base preflight first, then the drive-mode ask').length === 3);
ok('UAT follow-up starts with the preflight', engines.includes('starting with the stale-base preflight'));

for (const rel of ['_shared/teamwork.md', '_shared/configuration-reference.md', '_shared/techniques/acceptance-testing.md', 'trailhead-work/references/ticket-engines.md', 'trailhead-work/references/auto.md']) {
  ok(`${rel} has no em-dash`, !read(rel).includes('—'));
}

console.log(`base-preflight-docs.test.js: ${passed} checks passed`);
