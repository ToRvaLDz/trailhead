#!/usr/bin/env node
// Docs test: una decision chiusa porta il suo lavoro nei build (riga `Builds:`), il grill
// che risolve un ticket fa lo stesso, e l'audit segnala le decisioni chiuse senza build.
// Plain asserts, no framework. Run: node bin/decision-builds-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const EM = String.fromCharCode(0x2014);

// Sezione dal suo heading fino al prossimo heading dello stesso livello (o superiore).
const section = (text, headingRe) => {
  const m = headingRe.exec(text);
  if (!m) return '';
  const level = m[0].match(/^#+/)[0].length;
  const rest = text.slice(m.index + m[0].length);
  const next = new RegExp(`^#{1,${level}} `, 'm').exec(rest);
  return next ? rest.slice(0, next.index) : rest;
};

const SK = 'plugins/trailhead/skills';

// Motore decision
const engines = read(`${SK}/trailhead-work/references/ticket-engines.md`);
const dec = section(engines, /^## `decision`.*$/m);
ok('decision engine: section found', dec.length > 0);
ok('decision engine: a build follow-through step', /Carry it into build/.test(dec));
ok('decision engine: records a `Builds:` line', dec.includes('`Builds:'));
ok('decision engine: allows `Builds: none` only with a reason', /`Builds: none \(<why>\)`/.test(dec));
ok('decision engine: links existing tickets or creates build tickets', /existing/i.test(dec) && /create-then-wire/.test(dec));
ok('decision engine: the human confirms the build split in the final confirmation', /final confirmation/i.test(dec));
ok('decision engine: no close without the line', /never `gh issue close`/i.test(dec));
ok('decision engine: explains the fog that vanishes', /Not yet specified/.test(dec));
ok('decision engine: no em-dash', !dec.includes(EM));

// Work the map
const work = read(`${SK}/trailhead-work/SKILL.md`);
const step5 = (work.match(/^5\. Record the resolution:.*$/m) || [''])[0];
ok('work step 5: decision close waits on the `Builds:` line', step5.includes('`Builds:') && /Carry it into build/.test(step5));

// Grill su un ticket
const chart = read(`${SK}/trailhead-chart/SKILL.md`);
const grill = (chart.match(/^Run a standalone \*\*Grilling\*\*.*$/m) || [''])[0];
ok('grill: resolving a decision ticket carries it into build', /Carry it into build/.test(grill) && grill.includes('`Builds:'));

// Audit
const audit = read(`${SK}/trailhead-manage/references/auditing.md`);
const light = (audit.match(/^\*\*Light check\*\*.*$/m) || [''])[0];
ok('audit light check: flags a closed decision with no build', /no build/i.test(light) && light.includes('`Builds:'));
ok('audit light check: an older decision counts a build that links it', /links? (it|back)/i.test(light));
const report = section(audit, /^## 8\. Report$/m);
ok('audit report: lists decisions with no build', /no build/i.test(report));
const props = section(audit, /^## 9\. Proposals.*$/m);
ok('audit proposals: open the missing build tickets on a yes', /No build/.test(props) && /build/.test(props) && /`Builds:`/.test(props));

// Docs utente
const readme = read('README.md');
ok('README: decision engine leaves build tickets', /`decision` diverges options then grills to choose, then opens the build tickets/.test(readme));
ok('README: audit names decisions with no build', /decisions closed with no build/i.test(readme));
const readmeIt = read('README.it.md');
ok('README.it: decision engine leaves build tickets', /`decision` dirama le opzioni poi fa grilling per scegliere, poi apre i ticket build/.test(readmeIt));
ok('README.it: audit names decisions with no build', /decisioni chiuse senza build/i.test(readmeIt));
const wf = read('site/src/content/docs/docs/workflow.md');
ok('workflow.md: decision engine leaves build tickets', /`decision` diverges options then grills to choose, then opens the build tickets/.test(wf));
const manage = read('site/src/content/docs/docs/commands/manage.md');
ok('manage.md: audit names decisions with no build', /closed with no build/i.test(manage));
for (const [n, t] of [['README.md', readme], ['README.it.md', readmeIt], ['workflow.md', wf], ['manage.md', manage]]) {
  ok(`${n}: no em-dash`, !t.includes(EM));
}

console.log(`decision-builds-docs.test.js: ${passed} checks passed`);
