#!/usr/bin/env node
// Docs test for #362: the docs name the test-run helper, its config keys, the
// queue and cache contract, and carry no em-dash.
// Run: node test-run-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const docs = {
  'ticket-engines.md': read(skills, 'trailhead-work', 'references', 'ticket-engines.md'),
  'executor-brief.md': read(skills, 'trailhead-work', 'references', 'executor-brief.md'),
  'teamwork.md': read(skills, '_shared', 'teamwork.md'),
  'configuration-reference.md': read(skills, '_shared', 'configuration-reference.md'),
  'README.md': read(root, 'README.md'),
  'README.it.md': read(root, 'README.it.md'),
  'configuration.mdx': read(root, 'site', 'src', 'content', 'docs', 'docs', 'configuration.mdx'),
};

for (const name of ['ticket-engines.md', 'executor-brief.md', 'teamwork.md']) {
  ok(`${name} names the helper`, docs[name].includes('trailhead-test-run.js'));
}
ok('ticket-engines.md names the full run command', docs['ticket-engines.md'].includes('trailhead-test-run.js run --repo <working-root> --config-root <project root>'));
ok('ticket-engines.md names the targeted run', docs['ticket-engines.md'].includes('--kind targeted --files'));
ok('ticket-engines.md names the unconfigured fallback', docs['ticket-engines.md'].includes('`unconfigured` falls back'));

for (const name of ['configuration-reference.md', 'README.md', 'README.it.md', 'configuration.mdx']) {
  for (const key of ['testing.full', 'testing.targeted', 'testing.maxParallel']) {
    ok(`${name} documents ${key}`, docs[name].includes(key));
  }
}
const ref = docs['configuration-reference.md'];
for (const needle of ['**Test runs.**', 'TRAILHEAD_CACHE_DIR', 'nice -n 10', 'ionice -c 3', '--no-cache', 'tree SHA + command', '🧪 Test suite']) {
  ok(`configuration-reference.md carries: ${needle}`, ref.includes(needle));
}
ok('README.md carries the Test runs paragraph', docs['README.md'].includes('**Test runs.**'));
ok('README.it.md carries the mirrored paragraph', docs['README.it.md'].includes('**Esecuzioni dei test.**'));

for (const [name, text] of Object.entries(docs)) ok(`${name} has no em-dash`, !text.includes('—'));

console.log(`test-run-docs.test.js: ${passed} checks passed`);
