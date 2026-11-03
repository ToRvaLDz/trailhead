#!/usr/bin/env node
// Docs test for #363: the engine runs the full test suite once per ticket.
// Execute/Fix run focused tests, Verify runs the full suite once on the synced
// tree and records it, the reviewing agents read that record, and no em-dash.
// Run: node test-once-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const agents = path.join(root, 'plugins', 'trailhead', 'agents');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const docs = {
  'executor-brief.md': read(skills, 'trailhead-work', 'references', 'executor-brief.md'),
  'ticket-engines.md': read(skills, 'trailhead-work', 'references', 'ticket-engines.md'),
  'teamwork.md': read(skills, '_shared', 'teamwork.md'),
  'tdd.md': read(skills, '_shared', 'techniques', 'tdd.md'),
  'debug.md': read(skills, '_shared', 'techniques', 'debug.md'),
  'code-review.md': read(skills, '_shared', 'techniques', 'code-review.md'),
  'verify.md': read(skills, '_shared', 'techniques', 'verify.md'),
  'configuration-reference.md': read(skills, '_shared', 'configuration-reference.md'),
  'agent-blocks.md': read(root, 'scripts', 'agent-blocks.md'),
  'trailhead-code-review.md': read(agents, 'trailhead-code-review.md'),
  'trailhead-verify.md': read(agents, 'trailhead-verify.md'),
  'README.md': read(root, 'README.md'),
  'README.it.md': read(root, 'README.it.md'),
  'configuration.mdx': read(root, 'site', 'src', 'content', 'docs', 'docs', 'configuration.mdx'),
};

// Execute/Fix: focused tests only, never the whole suite.
const brief = docs['executor-brief.md'];
ok('executor-brief.md: focused tests only', brief.includes('run only the focused tests'));
ok('executor-brief.md: never the whole suite', brief.includes('never the whole suite'));
ok('executor-brief.md: targeted run through the helper', brief.includes('--kind targeted --files <a,b>'));
ok('tdd.md: loop runs focused tests', docs['tdd.md'].includes('focused tests'));
ok('tdd.md: full suite once at Verify', docs['tdd.md'].includes('once per ticket, at Verify'));

// Verify: one full run on the synced tree, recorded, read by the reviewers.
const engines = docs['ticket-engines.md'];
ok('ticket-engines.md: one full run per tree', (engines.match(/runs the full suite once on the synced tree/g) || []).length === 2);
ok('ticket-engines.md: test record named in build and bug Verify', (engines.match(/\*\*test record\*\*/g) || []).length === 2);
ok('ticket-engines.md: reviewers do not re-run', (engines.match(/never re-run the full suite/g) || []).length >= 2);
ok('ticket-engines.md: no double run after the sync', !engines.includes('then sync, then re-run the tests'));

// Post-sync re-run reuses the cache.
ok('teamwork.md: post-sync run reuses the cached result', docs['teamwork.md'].includes('`source: cache`'));
ok('teamwork.md: current needs no re-run', docs['teamwork.md'].includes('`current` needs no re-run'));

// Reviewing agents read the record.
for (const name of ['code-review.md', 'verify.md', 'agent-blocks.md', 'trailhead-code-review.md', 'trailhead-verify.md']) {
  ok(`${name}: reads the test record`, docs[name].includes('test record'));
  ok(`${name}: never re-runs the full suite`, docs[name].includes('never re-run the full suite'));
}

// Debug step 9 through the helper.
ok('debug.md: full suite through the helper', /full suite green[^\n]*trailhead-test-run\.js/.test(docs['debug.md']));

// Config docs.
ok('configuration-reference.md: once per ticket', docs['configuration-reference.md'].includes('once per ticket'));
ok('README.md: once per ticket', docs['README.md'].includes('once per ticket'));
ok('README.it.md: una volta per ticket', docs['README.it.md'].includes('una volta per ticket'));
ok('configuration.mdx: once per ticket', docs['configuration.mdx'].includes('once per ticket'));

for (const [name, text] of Object.entries(docs)) ok(`${name} has no em-dash`, !text.includes('—'));

console.log(`test-once-docs.test.js: ${passed} checks passed`);
