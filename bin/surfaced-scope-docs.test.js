#!/usr/bin/env node
// Docs test: un ticket aperto a metà lavoro va sulla mappa corrente (o su quella giusta)
// se il tema è suo; altrimenti si chiede fra mappe aperte e whiteboard, mai whiteboard
// in silenzio; dopo la creazione si dice dove è stato aperto. I rimandi puntano al file.
// Plain asserts, no framework. Run: node bin/surfaced-scope-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const EM = String.fromCharCode(0x2014);

const SK = 'plugins/trailhead/skills';
const REF = 'Scope that surfaces while working a ticket';

// La regola condivisa
const rule = read(`${SK}/_shared/surfaced-scope.md`);
ok('rule: titled after the referenced name', rule.startsWith(`# ${REF}`));
ok('rule: do it, split it, or capture it', /\*\*`split`\*\* X/.test(rule) && /capture and continue/.test(rule));
ok('rule: Surfaced from lineage line', /`Surfaced from: /.test(rule));
ok('rule: current map first when the topic is its own', /1\. \*\*The current map[^\n]*no ask/.test(rule));
ok('rule: another open map when the topic clearly is its', /2\. \*\*Another open map[^\n]*no ask/.test(rule));
ok('rule: otherwise ask, listing every open map and the whiteboard', /3\. \*\*Otherwise, ask\.\*\*[^\n]*AskUserQuestion[^\n]*every open map[^\n]*whiteboard/.test(rule));
ok('rule: never the whiteboard silently while a map is open', /Never route to the whiteboard without this ask while any map is open/.test(rule));
ok('rule: no map open falls to the whiteboard', /4\. \*\*No map open → whiteboard, no ask\*\*/.test(rule));
ok('rule: auto defers an ask case instead of guessing', /autonomous run[^\n]*rule 3[^\n]*Pending follow-up guard/.test(rule));
ok('rule: announce the ticket and where it landed', /## Say what you opened, and where/.test(rule) && /\*\*where it landed\*\*/.test(rule));
ok('rule: no em-dash', !rule.includes(EM));

// Ogni rimando al nome porta al file (nessun rimando orfano)
const referrers = [
  `${SK}/_shared/session-handoff.md`,
  `${SK}/_shared/techniques/code-review.md`,
  `${SK}/trailhead-work/SKILL.md`,
  `${SK}/trailhead-work/references/ticket-engines.md`,
];
for (const rel of referrers) {
  const text = read(rel);
  const lines = text.split('\n').filter((l) => l.includes(REF));
  ok(`${rel}: mentions the rule`, lines.length > 0);
  ok(`${rel}: every mention links surfaced-scope.md`, lines.every((l) => /surfaced-scope\.md/.test(l)));
  ok(`${rel}: no "served by the capture cluster" dangling pointer`, lines.every((l) => !/served by the capture cluster/.test(l)));
}

// Capture e UAT seguono la stessa regola
const capture = read(`${SK}/trailhead-capture/references/capture.md`);
// #330: capture.md no longer links the full core; it states the routing inline and
// capture-core.md carries drift markers on the surfaced-scope.md rules it restates.
ok('capture: a mid-ticket capture states the surfaced-scope routing inline', /\*\*A capture fired mid-ticket\*\*[^\n]*the current map[^\n]*Surfaced from:/.test(capture));
ok('capture-core: surfaced-scope.md rules are drift-stamped', /<!-- core: surfaced-scope\.md \|/.test(read(`${SK}/_shared/capture-core.md`)));
const uat = read(`${SK}/_shared/techniques/acceptance-testing.md`);
ok('uat: the failing-step follow-up lands per surfaced-scope.md', /On a failing step[^\n]*surfaced-scope\.md/.test(uat));

// Scrivere su un ticket esistente: prima si controlla che sia ancora aperto (#406)
const HEAD = '## Writing onto an existing ticket: check it is still open';
ok('rule: has the check-open section', rule.includes(HEAD));
const sec = rule.includes(HEAD) ? rule.split(HEAD)[1].split(/\n## /)[0] : '';
ok('rule: section sits between landing and announce sections', rule.indexOf('## Where the surfaced ticket lands') < rule.indexOf(HEAD) && rule.indexOf(HEAD) < rule.indexOf('## Say what you opened, and where'));
ok('rule: reads the target state with --json state', /gh issue view <n> --json state/.test(sec));
ok('rule: open target is written as proposed', /Open[^\n]*write (it )?there/i.test(sec));
ok('rule: closed target gets a new ticket with Surfaced from and a pointer to the closed one', /Closed[^\n]*new ticket[^\n]*`Surfaced from: [^\n]*`Follows up: /.test(sec));
ok('rule: a closed map is not a destination', /closed map is not a destination/.test(sec));
ok('rule: user told in one line', /one line[^\n]*closed/i.test(sec));
ok('rule: section has no em-dash', !sec.includes(EM));
const crText = read(`${SK}/_shared/techniques/code-review.md`);
ok('code-review: deferred target state checked per surfaced-scope.md', /deferred[^\n]*Writing onto an existing ticket[^\n]*surfaced-scope\.md/.test(crText));
const coreText = read(`${SK}/_shared/capture-core.md`);
const mbw = coreText.split('## Map body writes')[1] || '';
// capture-core.md may not name another _shared file outside drift markers, so it cites the rule by name
ok('capture-core: map body writes check the target state per the surfaced-scope rule', /--json state[^\n]*surfaced-scope rule[^\n]*Writing onto an existing ticket/.test(mbw));
ok('code-review/capture-core: no em-dash', !crText.includes(EM) && !coreText.includes(EM));

console.log(`surfaced-scope-docs.test.js: ${passed} checks passed`);
