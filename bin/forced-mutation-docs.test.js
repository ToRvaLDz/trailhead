#!/usr/bin/env node
// Docs test for #357: a red obtained by forcing a change (mutating code or a
// fixture) counts only after the change is shown to have landed, stated by the
// RED step of TDD and by the "watch it fail" step of Debug.
// Run: node forced-mutation-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const techniques = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills', '_shared', 'techniques');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const RULE = 'prove the change landed before trusting the run: diff the mutated file against a clean copy, or re-read it, and see the mutation there';
const WHY = 'A mutation that silently failed to apply leaves the code as it was, so the run proves nothing';

const tdd = read(techniques, 'tdd.md');
const debug = read(techniques, 'debug.md');

const red = tdd.split('\n').find((l) => l.startsWith('- **RED**:')) || '';
ok('tdd: the RED step carries the rule', red.includes(RULE));
ok('tdd: the RED step says why', red.includes(WHY));

const verifyFix = debug.split('\n').find((l) => l.startsWith('9. **Verify the fix.**')) || '';
ok('debug: the rule follows "watch it fail"', verifyFix.indexOf(RULE) > verifyFix.indexOf('Watch it fail') && verifyFix.includes('Watch it fail'));
ok('debug: the step says why', verifyFix.includes(WHY));

for (const [name, text] of Object.entries({
  'tdd.md': tdd,
  'debug.md': debug,
  'forced-mutation-docs.test.js': read(__dirname, 'forced-mutation-docs.test.js'),
})) {
  ok(`${name} has no em-dash`, !text.includes(String.fromCharCode(0x2014)));
}

console.log(`forced-mutation-docs.test.js: ${passed} checks passed`);
