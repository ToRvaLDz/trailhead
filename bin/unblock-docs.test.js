#!/usr/bin/env node
// Docs test for #322: resolving any ticket (map or whiteboard, via work or quick) unblocks
// its dependents, as a step independent of the map-only `Decisions so far` book-keeping.
// Plain asserts, no framework. Run: node bin/unblock-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.resolve(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (p) => fs.readFileSync(path.join(skills, p), 'utf8');
const engines = read('trailhead-work/references/ticket-engines.md');
const work = read('trailhead-work/SKILL.md');
const commands = read('_shared/substrate-commands.md');
const HELPER = 'trailhead-unblock.js --issue <n> --repo <owner/name>';
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const resolveLine = (section) => {
  const start = engines.indexOf(section);
  const m = /^5\. \*\*Resolve\*\*.*$/m.exec(engines.slice(start));
  return m ? m[0] : '';
};
const unblockClause = (line) => {
  const i = line.indexOf('**Unblock dependents');
  if (i < 0) return '';
  // the clause ends at the next bold step (the handoff), not at a fixed window
  const end = line.indexOf('**Session handoff**', i);
  return line.slice(i, end < 0 ? undefined : end);
};

for (const section of ['## `build`', '## `bug`']) {
  const line = resolveLine(section);
  const clause = unblockClause(line);
  ok(`engines ${section}: Resolve has an Unblock dependents clause`, clause !== '');
  ok(`engines ${section}: names the helper`, clause.includes(HELPER));
  ok(`engines ${section}: applies to map and whiteboard tickets alike`, /whiteboard/.test(clause) && /map/.test(clause));
  ok(`engines ${section}: keeps the by-hand fallback`, clause.includes('--remove-label "trailhead:blocked"'));
  ok(`engines ${section}: independent of the map-only Decisions so far update`, /independent of the map-only `Decisions so far` update/.test(clause));
  ok(`engines ${section}: runs right after the close`, /^\*\*Unblock dependents[^*]*\*\*\s*Right after the close/.test(clause) && line.indexOf('gh issue close') < line.indexOf('**Unblock dependents'));
  ok(`engines ${section}: fallback names the blocked_by endpoint`, clause.includes('dependencies/blocked_by'));
}

const step5 = (/^5\. Record the resolution.*$/m.exec(work) || [''])[0];
ok('SKILL.md step 5: unblock is its own sentence naming the helper', /\.\s+Unblocking is a separate step[^]*\*\*unblock dependents\*\*/.test(step5) && step5.includes('trailhead-unblock.js'));
ok('SKILL.md step 5: holds for whiteboard tickets too', /whiteboard/.test(step5));

const bullet = (/^- \*\*No map narrative book-keeping\.\*\*.*$/m.exec(work) || [''])[0];
ok('SKILL.md quick bullet exists', bullet !== '');
ok('SKILL.md quick bullet: unblocking is among the steps that still hold', /Everything else holds:[^.]*unblocking dependents/.test(bullet) && bullet.includes('trailhead-unblock.js'));
ok('SKILL.md quick bullet: no map-only exception', !bullet.includes('Exception, `quick <n>` on a *map* ticket'));

ok('substrate-commands.md: unblock block names the helper as default', /Unblock:[\s\S]{0,400}trailhead-unblock\.js --issue <n> --repo <owner\/name>/.test(commands));
ok('substrate-commands.md: keeps the raw gh command as fallback', /Unblock:[\s\S]{0,700}gh issue edit <(?:n|dep)> --remove-label "trailhead:blocked"/.test(commands));
ok('substrate-commands.md: cookbook comment names the helper', /# unblock[^\n]*trailhead-unblock\.js/.test(commands));
ok('no em-dash', ![engines, work, commands].some((s) => s.includes(String.fromCharCode(0x2014))));
console.log(`unblock-docs.test.js: ${passed} checks passed`);
