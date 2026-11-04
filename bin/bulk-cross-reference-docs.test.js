#!/usr/bin/env node
// Docs test for #361: a bulk create (chart, adopt, split, a cluster) writes a cross-reference
// to a ticket of the same batch only in the wiring pass, from the ids just created, never guessed.
// Plain asserts, no framework. Run: node bin/bulk-cross-reference-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.resolve(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (p) => fs.readFileSync(path.join(skills, p), 'utf8');
const commands = read('_shared/substrate-commands.md');
const charting = read('trailhead-chart/references/charting.md');
const chart = read('trailhead-chart/SKILL.md');
const teamwork = read('_shared/teamwork.md');
const RULE = '**Cross-references in a bulk create.**';
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const rule = (commands.split('\n').find((l) => l.startsWith(RULE))) || '';
ok('cookbook: states the rule', rule !== '');
ok('cookbook: covers every #n and ticket link, not only blockers', /every `#n` and ticket link/.test(rule));
ok('cookbook: names the bulk paths', ['chart', 'adopt', 'split'].every((w) => rule.includes(w)));
ok('cookbook: the first pass refers to a sibling by name only', /first pass/.test(rule) && /by name/.test(rule));
ok('cookbook: written in the wiring pass from the ids just created', /wiring pass/.test(rule) && /ids just created/.test(rule));
ok('cookbook: says why a guess is harmful', /auto-links? to an unrelated issue/.test(rule));
ok('cookbook: the body edit obeys the fail-safe rule', /Fail-safe body rewrites/.test(rule));

const step4 = charting.split('\n').find((l) => l.startsWith('4. **Create the tickets you can specify now**')) || '';
ok('charting: step 4 applies the rule', step4.includes('Cross-references in a bulk create') && /never a guessed/.test(step4));

const splitStep = teamwork.split('\n').find((l) => l.startsWith('2. **Create the child tickets**')) || '';
ok('split: the children step applies the rule', splitStep.includes('Cross-references in a bulk create') && /never a guessed/.test(splitStep));

ok('ticket verb: a cluster applies the rule', chart.includes('Cross-references in a bulk create'));

console.log(`bulk-cross-reference-docs: ${passed} assertions passed`);
