#!/usr/bin/env node
// Docs test for #395: Resolve checks the codebase facets that cite the files a ticket
// touched, through trailhead-facet-touch.js, before the close.
// Plain asserts, no framework. Run: node bin/facet-touch-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const read = (p) => fs.readFileSync(p, 'utf8');
const engines = read(path.join(skills, 'trailhead-work/references/ticket-engines.md'));
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const resolveLine = (section) => {
  const start = engines.indexOf(section);
  const m = /^5\. \*\*Resolve\*\*.*$/m.exec(engines.slice(start));
  return m ? m[0] : '';
};
const clauseOf = (line) => {
  const i = line.indexOf('**Codebase facet check');
  if (i < 0) return '';
  const end = line.indexOf('When a structural event is due', i);
  return line.slice(i, end < 0 ? undefined : end);
};

for (const section of ['## `build`', '## `bug`']) {
  const line = resolveLine(section);
  const clause = clauseOf(line);
  ok(`${section}: Resolve has the Codebase facet check clause`, clause !== '');
  ok(`${section}: names the script and both subcommands`, clause.includes('trailhead-facet-touch.js check') && clause.includes('trailhead-facet-touch.js restamp'));
  ok(`${section}: passes the floor`, clause.includes('--floor <floor sha>'));
  ok(`${section}: closes only when pending is empty`, /close only when `pending` is empty/.test(clause));
  ok(`${section}: re-checks the body hash right before the close`, clause.includes('`bodyHash` is unchanged'));
  ok(`${section}: restamp needs a reason line`, clause.includes('--reason "<file>: <why>"') && clause.includes('`Codebase: <facet> patched`'));
  ok(`${section}: posts the validated file and stops the close on a failed post`, clause.includes('gh issue comment --body-file <draft>') && /a failed post stops the close/.test(clause));
  ok(`${section}: the audit pointer never blocks`, /`audit` line[^.]*never blocking/.test(clause));
  ok(`${section}: states the by-hand equivalent`, clause.includes('--is-ancestor') && /full equivalent/.test(clause));
  ok(`${section}: names no hook`, /No hook is involved/.test(clause) && !/hooks\.json|PreToolUse|SessionStart/.test(clause));
  ok(`${section}: keeps the patch clause`, /patch (?:just )?the affected facet/.test(line));
}

const techniques = read(path.join(skills, '_shared/techniques/codebase-map.md'));
const substrate = read(path.join(skills, '_shared/substrate.md'));
ok('codebase-map technique mirrors the check', techniques.includes('trailhead-facet-touch.js check') && /`pending` is empty/.test(techniques));
ok('substrate Codebase row mirrors the check', substrate.includes('trailhead-facet-touch.js check') && substrate.includes('`Codebase:` line'));
const concepts = read(path.join(root, 'site/src/content/docs/docs/concepts.md'));
ok('concepts names the facet check at Resolve', /Resolve checks the facets that cite the files a ticket touched/.test(concepts));
for (const f of ['plugins/trailhead/skills/trailhead-work/references/ticket-engines.md', 'plugins/trailhead/skills/_shared/techniques/codebase-map.md', 'plugins/trailhead/skills/_shared/substrate.md', 'site/src/content/docs/docs/concepts.md']) {
  ok(`${f}: no em-dash`, !read(path.join(root, f)).includes('—'));
}

console.log(`✓ facet-touch-docs: ${passed} assertions passed`);
