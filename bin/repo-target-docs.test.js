#!/usr/bin/env node
// Docs test for #351: the skill prose names the repo-target helper's check/record
// before the first tracker write, in load-first.md and in the capture cluster's
// compact core, and the marker stays gitignored.
// Run: node repo-target-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const shared = path.join(root, 'plugins', 'trailhead', 'skills', '_shared');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const read = (f) => fs.readFileSync(path.join(shared, f), 'utf8');
const loadFirst = read('load-first.md');
const captureCore = read('capture-core.md');
const teamwork = read('teamwork.md');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

const HEAD = '**Repo target check, once per session, before the first tracker write.**';
ok('load-first.md carries the repo target paragraph', loadFirst.includes(HEAD));
ok('capture-core.md carries a drift marker to it', captureCore.includes(`<!-- core: load-first.md | ${HEAD} |`));

for (const [name, text] of [['load-first.md', loadFirst], ['capture-core.md', captureCore], ['teamwork.md', teamwork]]) {
  ok(`${name} has no em-dash`, !text.includes('—'));
}
for (const [name, text] of [['load-first.md', loadFirst], ['capture-core.md', captureCore]]) {
  ok(`${name} names check`, text.includes('trailhead-repo-target.js check'));
  ok(`${name} names record`, text.includes('trailhead-repo-target.js record'));
  ok(`${name} says record gitignores the marker`, text.includes('`.gitignore` if absent'));
  ok(`${name} names the marker`, text.includes('.trailhead/repo-target.json'));
}
ok('capture-core.md places the check before the create commands',
  captureCore.indexOf('## Repo target check') !== -1 && captureCore.indexOf('## Repo target check') < captureCore.indexOf('gh issue create'));
ok('capture-core.md tells trailhead-capture.js callers to pass the target', captureCore.includes('as `--repo`'));
ok('teamwork.md lists the marker with its siblings', teamwork.includes('**Repo target record.**') && teamwork.includes('isolation-answer.json'));
ok('.gitignore carries the record', gitignore.split('\n').includes('.trailhead/repo-target.json'));

console.log(`repo-target-docs.test.js: ${passed} checks passed`);
