#!/usr/bin/env node
// Docs test for #282: the needs-you label (an autonomous run parks a ticket for the
// human) is documented where the run, the claim and the substrate depend on it.
// Plain asserts, no framework. Run: node bin/needs-you-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.resolve(__dirname, '..', 'plugins', 'trailhead');
const read = (rel) => fs.readFileSync(path.join(plugin, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const auto = read('skills/trailhead-work/references/auto.md');
const work = read('skills/trailhead-work/SKILL.md');
const substrate = read('skills/_shared/substrate.md');
const commands = read('skills/_shared/substrate-commands.md');

for (const needle of ['trailhead:needs-you', 'trailhead-needs-you.js park', '`NEEDS YOU`', 'needs-you ticket', 'queue skips it', 'does not reconsider it', 'surviving blocking review concern', 'stale-base stop', 'a failing UAT setup'.replace('a failing', 'failing')]) {
  ok(`auto.md names: ${needle}`, auto.includes(needle));
}
ok('auto.md no longer says "set aside" / "set-aside"', !/set[- ]aside|sets? (?:it|that|such a|the) (?:ticket )?aside|sets? .{0,20} aside/i.test(auto));

const claimStep = (work.match(/^2\. Choose the ticket\..*$/m) || [''])[0];
const quickBullet = (work.match(/^- \*\*Same isolation setup as `work`\.\*\*.*$/m) || [''])[0];
const CLEAR = 'node <templates>/trailhead-needs-you.js clear --issue <n> --repo <owner/name>';
ok('work claim step clears needs-you with the helper', claimStep.includes(CLEAR));
ok('quick isolation bullet clears needs-you with the helper', quickBullet.includes(CLEAR));
ok('work claim step has the by-hand fallback', claimStep.includes('gh issue edit <n> --remove-label trailhead:needs-you'));
ok('a failed clear is reported, never blocking the claim (work)', /failed `clear` is reported to the user in one line but never blocks the claim/.test(claimStep));
ok('a failed clear is reported, never blocking the claim (quick)', /failed `clear` is reported to the user in one line but never blocks the claim/.test(quickBullet));

ok('substrate.md documents the label, off every run, on the human frontier', /\*\*`trailhead:needs-you`\*\*[\s\S]{0,900}not a frontier exclusion for humans/.test(substrate) && substrate.includes('twenty-one labels'));
ok('substrate-commands.md ensures the label idempotently', commands.includes('gh label create trailhead:needs-you --color D93F0B --description "Needs you: an autonomous run parked it for the human" --force'));
ok('substrate-commands.md documents park and clear', commands.includes('trailhead-needs-you.js park --issue <n> --reason <text> --repo <owner/name>') && commands.includes('trailhead-needs-you.js clear --issue <n> --repo <owner/name>'));
ok('substrate-commands.md first-use list has twenty-one labels', /all twenty-one:[^\n]*`trailhead:needs-you`/.test(commands));

for (const [name, text] of [['auto.md', auto], ['SKILL.md', work], ['substrate.md', substrate], ['substrate-commands.md', commands]]) {
  ok(`${name}: no em-dash`, !text.includes('—'));
}
console.log(`needs-you-docs.test.js: ${passed} checks passed`);
