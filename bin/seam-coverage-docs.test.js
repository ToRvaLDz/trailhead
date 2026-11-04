#!/usr/bin/env node
// Docs test for #356: every seam a PLAN names carries one line saying what it
// catches and what it misses, stated by the TDD technique, the Plan step and
// the plan agent's return contract.
// Run: node seam-coverage-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const LINE = '`<seam>: catches <what a test here fails on>; misses <what gets through it>`';

const tdd = read(skills, '_shared', 'techniques', 'tdd.md');
const engines = read(skills, 'trailhead-work', 'references', 'ticket-engines.md');
const blocks = read(root, 'scripts', 'agent-blocks.md');
const agent = read(root, 'plugins', 'trailhead', 'agents', 'trailhead-plan.md');

ok('tdd: states the seam line', tdd.includes(LINE));
ok('tdd: a seam line is required in the PLAN', tdd.includes('the PLAN lists each one with its one line'));
ok('tdd: misses is never empty', tdd.includes('`misses` is never empty'));

const planStep = engines.split('\n').find((l) => l.startsWith('2. **Plan**:')) || '';
ok('plan step: the PLAN comment carries the seam line',
  planStep.includes('The step produces a `PLAN` comment: the steps, the seams (each with its one-line catches/misses, per **TDD**), the files touched, the verification criteria.'));

const contract = `\`ready\`: the rest of the report is the PLAN (the \`body\`): the steps, the seams (one line each, ${LINE}), the files touched and the verification criteria.`;
ok('agent blocks: the plan contract carries the seam line', blocks.includes(contract));
ok('plan agent: the contract carries the seam line', agent.includes(contract));

for (const [name, text] of Object.entries({
  'tdd.md': tdd,
  'ticket-engines.md': engines,
  'agent-blocks.md': blocks,
  'trailhead-plan.md': agent,
  'seam-coverage-docs.test.js': read(__dirname, 'seam-coverage-docs.test.js'),
})) {
  ok(`${name} has no em-dash`, !text.includes(String.fromCharCode(0x2014)));
}

console.log(`seam-coverage-docs.test.js: ${passed} checks passed`);
