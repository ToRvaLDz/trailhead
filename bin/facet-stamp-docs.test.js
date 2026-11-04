#!/usr/bin/env node
// Docs test for #360: every codebase facet is stamped with the commit it is true
// at, the Resolve patches of build and bug restamp the facet they touch, and the
// audit flags facets whose files moved after their stamp.
// Run: node facet-stamp-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const docs = path.join(root, 'site', 'src', 'content', 'docs', 'docs');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const map = read(skills, '_shared', 'techniques', 'codebase-map.md');
const substrate = read(skills, '_shared', 'substrate.md');
const engines = read(skills, 'trailhead-work', 'references', 'ticket-engines.md');
const auditing = read(skills, 'trailhead-manage', 'references', 'auditing.md');
const manage = read(docs, 'commands', 'manage.md');
const concepts = read(docs, 'concepts.md');

// The format and who writes it: codebase-map.md.
ok('map: facet stamp format', map.includes('`_as of <short sha>_`'));
ok('map: stamp comes from the scan root HEAD', map.includes('`git -C <scan root> rev-parse --short HEAD`'));
ok('map: a full re-run restamps every facet', /full re-run[^.]*restamps? (?:all|every)/i.test(map));
ok('map: a patch passes --stamp', map.includes('--section "<facet>" --stamp <short sha>'));
ok('map: an unstamped facet gains it on its next patch', /no stamp[^.]*gains it on its next patch/i.test(map));
ok('map: an untouched facet keeps its stamp', /untouched[^.]*keeps its (?:old )?stamp/i.test(map));

// The substrate row states the stamp.
const codebaseRow = substrate.split('\n').find((l) => l.startsWith('| Codebase |')) || '';
ok('substrate: Codebase row states the stamp', codebaseRow.includes('`_as of <short sha>_`'));

// Resolve of build and bug.
const resolves = engines.split('\n').filter((l) => l.startsWith('5. **Resolve**'));
ok('engines: build and bug Resolve both found', resolves.length === 2);
for (const [name, line] of [['build', resolves[0] || ''], ['bug', resolves[1] || '']]) {
  ok(`engines ${name}: the facet patch passes --stamp`, line.includes('--stamp'));
  ok(`engines ${name}: stamp is the trunk tip after integration`, /trunk tip/.test(line));
  ok(`engines ${name}: a pr not merged yet stamps the fork point`, line.includes('git merge-base HEAD origin/<trunk>'));
  ok(`engines ${name}: by-hand fallback updates the stamp line`, /by hand[^.]*stamp line/i.test(line));
}

// The audit.
const secStart = auditing.indexOf('## 7b. Codebase facets');
const secEnd = auditing.indexOf('## 8. Report');
const sec = secStart >= 0 ? auditing.slice(secStart, secEnd) : '';
ok('auditing: 7b sits between 7 and 8', secStart > auditing.indexOf('## 7. Compare the open tickets') && secEnd > secStart);
ok('auditing 7b: runs the script facets command', sec.includes('trailhead-audit-walk.js facets --repo'));
ok('auditing 7b: whole-repo runs only', /whole-repo/.test(sec) && /\[map\]/.test(sec));
ok('auditing 7b: no codebase issue skips it', /no `trailhead:codebase` issue/.test(sec));
ok('auditing 7b: singleton fail-closed lookup', /fail-closed/.test(sec));
ok('auditing 7b: body in a private mktemp directory removed on every path', sec.includes('mktemp -d') && /every path/.test(sec));
ok('auditing 7b: a script failure never blocks the audit or the marker', /never blocks the audit or the marker/.test(sec));
for (const status of ['current', 'stale', 'unstamped', 'unresolved', 'no-paths']) {
  ok(`auditing 7b: status ${status}`, sec.includes(`\`${status}\``));
}
const report = auditing.slice(secEnd, auditing.indexOf('## 9. Proposals'));
ok('auditing 8: report lists stale facets with changed files, outside the sum', /stale facets?[^.]*changed files/i.test(report) && /outside the (?:class )?sum/.test(report));
const proposals = auditing.slice(auditing.indexOf('## 9. Proposals'), auditing.indexOf('## 10.'));
ok('auditing 9: stale facets get no proposal', /\*\*Stale facets\*\* → no proposal/.test(proposals));

// Reader-facing docs.
ok('site manage: audit mentions stale codebase facets', /codebase facet/i.test(manage) && /as of/.test(manage));
ok('site concepts: codebase bullet mentions the stamp', concepts.split('\n').some((l) => l.includes('`trailhead:codebase`') && /as of/.test(l)));

console.log(`facet-stamp-docs.test.js: ${passed} checks passed`);
