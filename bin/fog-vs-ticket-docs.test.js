#!/usr/bin/env node
// Docs test: il charting apre come ticket (bloccati se serve) le aree con una Question
// già scrivibile, lascia in fog solo il resto; dopo ogni risoluzione la fog viene
// riesaminata tutta; a frontier vuota si propone un gruppo di voci da graduare.
// Plain asserts, no framework. Run: node bin/fog-vs-ticket-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const EM = String.fromCharCode(0x2014);
const line = (text, re) => (text.match(re) || [''])[0];

const SK = 'plugins/trailhead/skills';

// Charting: il criterio ticket vs fog
const charting = read(`${SK}/trailhead-chart/references/charting.md`);
const step4 = line(charting, /^4\. \*\*Create the tickets you can specify now\*\*.*$/m);
ok('charting step 4: names the ticket-or-fog test', /Ticket or fog/.test(step4));
ok('charting step 4: a writable Question makes a ticket even when blocked', /Question/.test(step4) && /blocked/.test(step4) && /not a reason to leave it in the fog/i.test(step4));
ok('charting step 4: fog only when the question cannot be phrased yet', /cannot phrase/i.test(step4));
ok('charting step 4: fog when an open decision could reshape the question, and the entry says which', /reshape/i.test(step4) && /names? (that|the) (decision|ticket)/i.test(step4));
ok('charting step 4: the 100 sub-issue cap is the only volume brake', /100/.test(step4));
ok('charting: no em-dash', !charting.includes(EM));

// Work the map: riesame di tutta la fog dopo ogni risoluzione
const work = read(`${SK}/trailhead-work/SKILL.md`);
const step6 = line(work, /^6\. Add newly-surfaced tickets.*$/m);
ok('work step 6: re-scans every fog entry', /every entry/i.test(step6) && /Not yet specified/.test(step6));
ok('work step 6: applies the charting test', /Ticket or fog/.test(step6));
ok('work step 6: proposes the graduations as one batch', /one batch/i.test(step6));

// Handoff a frontier vuota: un gruppo, non una voce
const handoff = read(`${SK}/_shared/session-handoff.md`);
const empty = line(handoff, /^\s*\*\*If the frontier is empty\*\*.*$/m);
ok('handoff: empty frontier proposes a batch of ripe fog entries', /batch/i.test(empty) && /Ticket or fog/.test(empty));
ok('handoff: no em-dash', !handoff.includes(EM));

// Docs utente
const docs = [
  ['README.md', read('README.md'), false],
  ['README.it.md', read('README.it.md'), true],
  ['concepts.md', read('site/src/content/docs/docs/concepts.md'), false],
];
for (const [n, t, it] of docs) {
  ok(`${n}: fog no longer clears "one at a time"`, it ? !/una alla volta, finché non resta/.test(t) : !/ticket, one at a time, until nothing/.test(t));
  ok(`${n}: a phrasable question is a ticket, blocked if needed`, it
    ? /domanda già formulabile[^.]*ticket[^.]*bloccat/i.test(t)
    : /question you can already phrase[^.]*ticket[^.]*blocked/i.test(t));
  ok(`${n}: no em-dash`, !t.includes(EM));
}

console.log(`fog-vs-ticket-docs.test.js: ${passed} checks passed`);
