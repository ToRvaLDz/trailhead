#!/usr/bin/env node
// Docs test for #313: /trailhead:auto is introduced at the entry points and each `auto`
// section opens with an intro, a run example and the main-checkout note.
// Plain asserts, no framework. Run: node bin/auto-intro-docs.test.js
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
// Testa della sezione: prima del primo bullet o sotto-heading.
const head = (sec) => {
  const i = sec.search(/^(- |### )/m);
  return i < 0 ? sec : sec.slice(0, i);
};

const docs = [
  { name: 'README.md', rel: 'README.md', re: /^### .*Autonomous run: `auto`\s*$/m, it: false },
  { name: 'README.it.md', rel: 'README.it.md', re: /^### .*Run autonoma: `auto`\s*$/m, it: true },
  { name: 'workflow.md', rel: 'site/src/content/docs/docs/workflow.md', re: /^## Autonomous run: `auto`\s*$/m, it: false },
];

for (const d of docs) {
  const text = read(d.rel);
  const sec = section(text, d.re);
  const intro = head(sec);
  ok(`${d.name}: auto section found`, sec.length > 0);
  ok(`${d.name}: intro says it drains a map or the whiteboard unattended`, d.it
    ? /svuota/i.test(intro) && /mappa/i.test(intro) && /whiteboard/i.test(intro) && /senza supervisione/i.test(intro)
    : /drains/i.test(intro) && /map/i.test(intro) && /whiteboard/i.test(intro) && /unattended/i.test(intro));
  ok(`${d.name}: intro contrasts with /trailhead:work`, intro.includes('/trailhead:work'));
  ok(`${d.name}: intro names the run report, needs-you tickets and local commits to push`,
    /run report/i.test(intro) && /needs-you/.test(intro) && /push/i.test(intro));
  const block = /```[^\n]*\n([\s\S]*?)```/.exec(intro + sec.slice(intro.length));
  const ex = block ? block[1] : '';
  ok(`${d.name}: run example has a progress line`, /slot/i.test(ex) && /(resolved|next)/i.test(ex));
  ok(`${d.name}: run example has a report excerpt`, ['Stopped:', 'Resolved:', 'Merged:', 'Remains:'].every((k) => ex.includes(k)));
  ok(`${d.name}: main-checkout note (fast-forward or merge commit, dirty tracked tree stops, untracked does not)`, d.it
    ? /fast-forward/.test(sec) && /merge commit/.test(sec) && /checkout principale/i.test(sec) && /non committat/i.test(sec) && /untracked/i.test(sec)
    : /fast-forward/.test(sec) && /merge commit/.test(sec) && /main checkout/i.test(sec) && /uncommitted/i.test(sec) && /untracked/i.test(sec));
  ok(`${d.name}: no em-dash`, !text.includes(EM));
}

for (const [name, rel] of [['README.md', 'README.md'], ['README.it.md', 'README.it.md']]) {
  const t = read(rel);
  const pitch = t.slice(0, t.search(/^## .*Install/m));
  ok(`${name}: the pitch names /trailhead:auto`, pitch.includes('/trailhead:auto'));
}

const landing = read('site/src/components/landing/HowItWorks.astro');
ok('landing: mentions /trailhead:auto', /<code>\/trailhead:auto<\/code>/.test(landing));
const sentence = (landing.match(/[^.>]*<code>\/trailhead:auto<\/code>[^.<]*/) || [''])[0];
ok('landing: the new sentence has no em-dash', sentence.length > 0 && !sentence.includes(EM));

const gs = read('site/src/content/docs/docs/getting-started.mdx');
ok('getting-started: links the autonomous run section', gs.includes('(/docs/workflow#autonomous-run-auto)'));
ok('getting-started: no em-dash', !gs.includes(EM));

console.log(`auto-intro-docs.test.js: ${passed} checks passed`);
