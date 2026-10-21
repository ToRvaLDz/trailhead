#!/usr/bin/env node
// Docs test: the agent never offers or acts on its own pick unchecked. The stress-test rule is
// stated once (choices.md) and pointed at by grilling, the delegate option, auto and the Plan;
// the Plan carries a Done-when coverage check, decision Diverge re-checks a framed option set,
// and inbox never closes or answers someone else's issue without the user's yes.
// Run: node pick-stress-test-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const ANCHOR = 'Stress-test the pick before offering it';
const DEFINITION = `**${ANCHOR}.**`;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const lineOf = (text, pred) => text.split('\n').find(pred);

// 1. la definizione esiste una sola volta, in choices.md
const defs = walk(skills).filter((f) => fs.readFileSync(f, 'utf8').includes(DEFINITION));
ok('definition appears in exactly one file', defs.length === 1);
ok('definition lives in choices.md', defs[0] === path.join(skills, '_shared', 'choices.md'));
const choices = read('_shared/choices.md');
ok('definition appears once', choices.split(DEFINITION).length === 2);

// 2. la definizione porta i frammenti normativi
const rule = lineOf(choices, (l) => l.includes(DEFINITION));
for (const frag of [
  'a recommended answer in grilling',
  '`(Recommended)`',
  'the delegate option',
  'an option `auto` takes on its own',
  'the edge case or failure mode where it breaks',
  'checked against the code rather than assumed',
  'the choices already settled',
  'real holes, not manufactured doubt',
  'One pass, no loop',
  'present only that',
  'Weak point:',
  'still recommended because',
  'conversation language',
  'where no human sees it live',
  'trivial or already-decided choice',
]) ok(`rule carries: ${frag}`, rule.includes(frag));

// 3. i call-site puntano alla regola senza ripeterla
const pointer = (name, line) => {
  ok(`${name} found`, !!line);
  ok(`${name} references the anchor`, line.includes(ANCHOR));
  ok(`${name} does not restate the rule`, !line.includes('manufactured doubt'));
};
const grilling = read('_shared/techniques/grilling.md');
const gl = grilling.split('\n');
const pickIdx = gl.findIndex((l) => l.startsWith('- **One question at a time, with your pick.**'));
ok('grilling pick bullet found', pickIdx >= 0);
pointer('grilling self-check bullet', gl[pickIdx + 1]);
ok('grilling bullet keeps the per-question check', gl[pickIdx + 1].includes('by question number'));
ok('grilling pick bullet points at the self-check', gl[pickIdx].includes('stress-tested per the next bullet'));
pointer('delegate step 2', lineOf(choices, (l) => l.startsWith('2. The agent states **which option it would choose')));
const auto = read('trailhead-work/references/auto.md');
const autoLine = lineOf(auto, (l) => l.startsWith('- **Advisory / process choice**'));
pointer('auto advisory choice', autoLine);
ok('auto records the weak point', autoLine.includes('`Weak point:` line'));
const engines = read('trailhead-work/references/ticket-engines.md');
const plan = lineOf(engines, (l) => l.startsWith('2. **Plan**'));
pointer('build Plan', plan);

// 4. Plan: copertura del Done when prima di ready
for (const frag of [
  '**Coverage check before `ready`.**',
  'every `Done when` criterion',
  'a criterion no step delivers is a gap',
  'return `needs_input`',
  'the short inline plan too',
]) ok(`plan carries: ${frag}`, plan.includes(frag));

// 5. Diverge: un set di opzioni gia' inquadrato viene ricontrollato
const diverge = lineOf(engines, (l) => l.startsWith('1. **Diverge'));
ok('diverge found', !!diverge);
ok('diverge no longer skips blindly', !diverge.includes('skip straight to grilling when it did.'));
for (const frag of ['still current and complete', 'Decisions so far', 'status quo', '`OPTIONS` comment'])
  ok(`diverge carries: ${frag}`, diverge.includes(frag));

// 6. Inbox: nessuna chiusura o commento pubblico senza un si'
const inbox = read('trailhead-chart/references/inbox.md');
ok('inbox drops "on your own for clear ones"', !inbox.includes('on your own for clear ones'));
const intro = lineOf(inbox, (l) => l.startsWith('For each issue in the first two sections'));
for (const frag of ['propose a disposition', 'one list', 'explicit yes', 'never close', 'comment on', 'out-of-scope ruling'])
  ok(`inbox intro carries: ${frag}`, intro.includes(frag));
const dup = lineOf(inbox, (l) => l.startsWith('- **Duplicate.**'));
for (const frag of ['what each one covers', 'partial overlap', 'not a duplicate'])
  ok(`inbox duplicate carries: ${frag}`, dup.includes(frag));

// 7. niente em-dash
for (const rel of ['_shared/choices.md', '_shared/techniques/grilling.md', 'trailhead-work/references/auto.md',
  'trailhead-work/references/ticket-engines.md', 'trailhead-chart/references/inbox.md'])
  ok(`${rel} has no em-dash`, !read(rel).includes(String.fromCharCode(8212)));
ok('this test has no em-dash', !fs.readFileSync(__filename, 'utf8').includes(String.fromCharCode(8212)));

console.log(`pick-stress-test-docs.test.js: ${passed} checks passed`);
