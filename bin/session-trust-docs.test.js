#!/usr/bin/env node
// Docs test for #333: the in-session trust rule accepts the same labellers as the label guard
// (github-actions[bot], TRAILHEAD_LABEL_ALLOWLIST logins, write+ collaborators). Plain asserts.
// Run: node bin/session-trust-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const tw = fs.readFileSync(path.join(skills, '_shared', 'teamwork.md'), 'utf8');
const inbox = fs.readFileSync(path.join(skills, 'trailhead-chart', 'references', 'inbox.md'), 'utf8');
const s = tw.indexOf('## Trust & provenance');
const e = tw.indexOf('**Repo-side enforcement');
const trust = s < 0 || e < s ? '' : tw.slice(s, e);
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

ok('teamwork.md has the trust section', trust !== '');
ok('bot is a trusted labeller', /`github-actions\[bot\]`[^]*trusted/i.test(trust));
ok('bot why: GITHUB_TOKEN events trigger no workflow', /GITHUB_TOKEN[^]*(trigger|run)s? no workflow[^]*guard/i.test(trust));
ok('allowlist read command', trust.includes('gh variable get TRAILHEAD_LABEL_ALLOWLIST'));
ok('allowlist: not found means empty', /not found[^]*(means|->|is) empty/i.test(trust));
ok('allowlist: other failure means unknown, not empty', /any other failure[^]*unknown/i.test(trust) && /unknown, not empty/i.test(trust));
ok('allowlist compare: comma-separated, trimmed, case-insensitive', /comma-separated[^]*trimmed[^]*case-insensitive/i.test(trust));
ok('unknown allowlist: held off frontier, provenance not checkable', /unknown[^]*held? off the frontier[^]*provenance not checkable/i.test(trust));
ok('never labelled unverified on a guess', /never[^.]*`trailhead:unverified`[^.]*guess/i.test(trust));
ok('failed permission lookup is unresolved too', /permission lookup (failed|fails)/i.test(trust) && /`404`[^]*real answer/i.test(trust));
ok('per-label provenance: latest labeled event of every label', /every `trailhead:\*` label[^]*latest `labeled` event[^]*all[^.]*trusted/i.test(trust));
ok('one trusted label does not vouch for another', /does not vouch for another/i.test(trust));
ok('still quarantines other non-write labellers', /`read`\/`none`[^]*not trusted/i.test(trust) && trust.includes('`trailhead:unverified`'));
ok('session and guard agree', /never strips/i.test(trust));
ok('inbox: session applies unverified, guard strips', /`trailhead:unverified`[^.]*applied by a session[^]*guard Action strips/i.test(inbox));
ok('inbox: rogue means outside the trusted labellers', /trusted labellers[^]*Trust rule|Trust rule[^]*trusted labellers/i.test(inbox) && /teamwork\.md#trust--provenance/.test(inbox));
ok('inbox: jq includes quarantined issues', /\| any\(startswith\("trailhead:"\)\) \| not\) or \(\[\.labels\[\]\.name\] \| any\(\. == "trailhead:unverified"\)\)/.test(inbox));
ok('no em-dash', !tw.includes(String.fromCharCode(0x2014)) && !inbox.includes(String.fromCharCode(0x2014)));
console.log(`session-trust-docs.test.js: ${passed} checks passed`);
