#!/usr/bin/env node
// Docs test for #245: the skill prose names the isolation-answer helper's check/record
// reuse for the `auto` work-start ask, its fingerprint contract and the 8-hour session.
// Run: node isolation-answer-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const teamwork = fs.readFileSync(path.join(skills, '_shared', 'teamwork.md'), 'utf8');
const workSkill = fs.readFileSync(path.join(skills, 'trailhead-work', 'SKILL.md'), 'utf8');
const choices = fs.readFileSync(path.join(skills, '_shared', 'choices.md'), 'utf8');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

for (const [name, text] of [['teamwork.md', teamwork], ['trailhead-work/SKILL.md', workSkill]]) {
  ok(`${name} names check`, text.includes('trailhead-isolation-answer.js check'));
  ok(`${name} names record`, text.includes('trailhead-isolation-answer.js record'));
  ok(`${name} has no em-dash`, !text.includes('—'));
}
ok('choices.md has no em-dash', !choices.includes('—'));

for (const needle of [
  '--others <csv|none|unavailable>',
  'unavailable',
  '8 hours',
  '`/trailhead:auto` and an explicit `none`/`worktree`/`clone` never read or write the record',
  "Isolation: reusing this session's answer",
  '.trailhead/isolation-answer.json',
  'three-dir lookup',
]) ok(`teamwork.md carries: ${needle}`, teamwork.includes(needle));

ok('.gitignore carries the record', gitignore.includes('.trailhead/isolation-answer.json'));

console.log(`isolation-answer-docs.test.js: ${passed} checks passed`);
