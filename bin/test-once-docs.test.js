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
ok('ticket-engines.md: no double run after the sync', !engines.includes('then sync, then re-run the tests'));

// Each Verify (build, bug) is its own line of ticket-engines.md.
const verifyLines = engines.split('\n').filter((l) => l.startsWith('4. **Verify**'));
ok('ticket-engines.md: build and bug Verify found', verifyLines.length === 2);
for (const [i, line] of verifyLines.entries()) {
  const which = i === 0 ? 'build' : 'bug';
  ok(`${which} Verify: exactly one full-run invocation`, (line.match(/trailhead-test-run\.js run --repo/g) || []).length === 1);
  ok(`${which} Verify: failed record reused on the same tree`, line.includes('reuse it instead of invoking the helper'));
  ok(`${which} Verify: reviewers never re-run, exactly once`, (line.match(/never re-run the full suite/g) || []).length === 1);
  ok(`${which} Verify: no legacy second run`, !line.includes('then run the tests') && !line.includes('then re-run the tests'));
}

// Scoping: the record and single-run rules apply only with testing.full.
ok('executor-brief.md: scoping names testing.full', /testing\.full[^\n]*focused/.test(brief));
ok('ticket-engines.md: unconfigured runs once, no record, reviewers get none', verifyLines.every((l) => l.includes('When the helper answers `unconfigured`, `unconfigured` falls back to the project\'s own command, run once on the synced tree: no test record is built and the reviewing agents get none, so they test as today.')));
ok('ticket-engines.md: no garbled as-before sentence', verifyLines.every((l) => !l.includes('behave as before')));
ok('ticket-engines.md: Execute/Fix focused clause kept', verifyLines.every((l) => l.includes('--kind targeted --files <a,b>')));
ok('configuration-reference.md: scoping names testing.full', /without `testing\.full`/i.test(docs['configuration-reference.md']));
ok('README.md: scoping names testing.full', /without `testing\.full`/i.test(docs['README.md']));
ok('configuration.mdx: scoping names testing.full', /without `testing\.full`/i.test(docs['configuration.mdx']));

// The reviewers never invoke the helper.
for (const name of ['code-review.md', 'verify.md', 'trailhead-code-review.md', 'trailhead-verify.md']) {
  ok(`${name}: no helper run invocation`, !docs[name].includes('trailhead-test-run.js run'));
}

// Post-sync re-run reuses the cache.
ok('teamwork.md: post-sync run reuses the cached result', docs['teamwork.md'].includes('`source: cache`'));
const tw = docs['teamwork.md'];
ok('teamwork.md: preflight never runs the suite', tw.includes('The preflight itself never runs the suite'));
ok('teamwork.md: never an extra invocation', tw.includes('never an extra invocation'));
ok('teamwork.md: Resolve new tree gets one run, record in the resolution comment', tw.includes('its test record is added to the resolution comment, superseding the Verify record'));
ok('teamwork.md: no separate re-run instruction after synced', !tw.includes('re-run the test suite on the synced tree') && !tw.includes('re-runs the tests'));
ok('teamwork.md: current needs no re-run', docs['teamwork.md'].includes('`current` needs no re-run'));

// Reviewing agents read the record.
for (const name of ['code-review.md', 'verify.md', 'agent-blocks.md', 'trailhead-code-review.md', 'trailhead-verify.md']) {
  ok(`${name}: no record without testing.full`, docs[name].includes('without `testing.full` no test record is passed'));
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
