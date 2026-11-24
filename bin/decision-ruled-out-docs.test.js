#!/usr/bin/env node
// Docs test: una decision chiusa e la DISCUSS di un build registrano le opzioni scartate
// (`Ruled out:`) e la condizione per riaprirle (`Revisit if:`); l'audit segnala i
// `Revisit if:` che sembrano avverati, senza mai riaprire da solo.
// Plain asserts, no framework. Run: node bin/decision-ruled-out-docs.test.js
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
const line = (text, re) => (text.match(re) || [''])[0];

const SK = 'plugins/trailhead/skills';

// Motore decision: Converge
const engines = read(`${SK}/trailhead-work/references/ticket-engines.md`);
const dec = section(engines, /^## `decision`.*$/m);
const converge = line(dec, /^2\. \*\*Converge\.\*\*.*$/m);
ok('decision converge: step found', converge.length > 0);
ok('decision converge: resolution carries a `Ruled out:` list', converge.includes('`Ruled out:`'));
ok('decision converge: each rejected option with its reason', /reason/i.test(converge));
ok('decision converge: optional `Revisit if:` line', converge.includes('`Revisit if:`') && /optional/i.test(converge));
ok('decision converge: `Revisit if:` names an observable condition', /observable/i.test(converge));
ok('decision converge: `Revisit if:` never invented', /never invent/i.test(converge));
ok('decision converge: a lone option writes `Ruled out: none (<why>)`', converge.includes('`Ruled out: none (<why>)`'));
ok('decision converge: the list stays on the ticket, not the map', /Decisions so far/.test(converge));
const carry = line(dec, /^3\. \*\*Carry it into build\.\*\*.*$/m);
ok('decision close: no close without `Ruled out:` either', /never `gh issue close`[^.]*`Ruled out:`/i.test(carry));
ok('decision engine: no em-dash', !dec.includes(EM));

// Motore build: Discuss
const build = section(engines, /^## `build`.*$/m);
const discuss = line(build, /^1\. \*\*Discuss\*\*.*$/m);
ok('build discuss: always its own `DISCUSS` comment', /own comment headed `DISCUSS`/.test(discuss));
ok('build discuss: never folded into the PLAN', /never folded into the `?PLAN`?/i.test(discuss));
ok('build discuss: closes with `Ruled out:` and optional `Revisit if:`', discuss.includes('`Ruled out:`') && discuss.includes('`Revisit if:`'));
ok('build engine: no em-dash', !build.includes(EM));

// Work the map step 5: la riga di Decisions so far
const work = read(`${SK}/trailhead-work/SKILL.md`);
const step5 = line(work, /^5\. Record the resolution:.*$/m);
ok('work step 5: Decisions so far line is the choice plus `Revisit if:`', step5.includes('`Revisit if:`') && /choice/.test(step5));
ok('work step 5: `Ruled out:` stays on the ticket', /`Ruled out:`[^.]*stays on the ticket/.test(step5));

// Grill che risolve un decision
const chart = read(`${SK}/trailhead-chart/SKILL.md`);
const grill = line(chart, /^Run a standalone \*\*Grilling\*\*.*$/m);
ok('grill: resolving a decision records `Ruled out:` and `Revisit if:`', grill.includes('`Ruled out:`') && grill.includes('`Revisit if:`'));
ok('grill: follows the Converge resolution format in full', /resolution format/.test(grill) && /Converge/.test(grill));

// Audit
const audit = read(`${SK}/trailhead-manage/references/auditing.md`);
const pass = section(audit, /^## 4b\. Revisit pass$/m);
ok('audit revisit pass: section found', pass.length > 0);
ok('audit revisit pass: closed decisions with `Revisit if:` only', /closed `decision`/.test(pass) && pass.includes('`Revisit if:`'));
ok('audit revisit pass: independent of the window and the marker', /independent of the (last-audit )?window/i.test(pass) && /marker/.test(pass));
ok('audit revisit pass: judged against the code or the tracker', /code or the tracker/.test(pass));
ok('audit revisit pass: an unclear condition is never reported as met', /never (reported )?as met/i.test(pass));
ok('audit revisit pass: no `Revisit if:` is never flagged', /without a `Revisit if:`[^.]*never flagged/i.test(pass));
ok('audit revisit pass: build DISCUSS comments are not audited', /DISCUSS[^.]*not audited/.test(pass));
ok('audit revisit pass: never rewinds the marker', /never rewinds/.test(pass));
const report = section(audit, /^## 8\. Report$/m);
ok('audit report: lists revisit candidates with the evidence', /revisit candidates/i.test(report) && /evidence/i.test(report));
const props = section(audit, /^## 9\. Proposals.*$/m);
const revisit = line(props, /^- \*\*Revisit\*\*.*$/m);
ok('audit proposals: revisit opens a linked `Revisits:` decision on an explicit yes', revisit.includes('`Revisits: <name+link>`') && /new `decision`/.test(revisit) && /explicit yes/.test(revisit));
ok('audit proposals: the old decision stays closed, its map line replaced', /stays closed/.test(revisit) && /Decisions so far/.test(revisit));
ok('audit proposals: never reopened automatically', /never/i.test(revisit) && /automatic/i.test(revisit));
ok('audit: no em-dash', !audit.includes(EM));

// Docs utente
const wf = read('site/src/content/docs/docs/workflow.md');
ok('workflow.md: decision records what was ruled out', /ruled out/i.test(wf));
const manage = read('site/src/content/docs/docs/commands/manage.md');
ok('manage.md: audit names revisit candidates', /revisit/i.test(manage) && manage.includes('`Revisit if:`'));
for (const [n, t] of [['workflow.md', wf], ['manage.md', manage], ['SKILL.md', work], ['chart SKILL.md', chart]]) {
  ok(`${n}: no em-dash`, !t.includes(EM));
}

console.log(`decision-ruled-out-docs.test.js: ${passed} checks passed`);
