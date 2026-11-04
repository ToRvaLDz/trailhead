#!/usr/bin/env node
// Docs test for #354: an inbox issue waiting on its reporter is parked with
// `trailhead:needs-info`, resurfaces only on the reporter's answer, and is offered
// for closing (never auto-closed) after inbox.needs_info_days.
// Plain asserts, no framework. Run: node bin/inbox-needs-info-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const plugin = path.join(root, 'plugins', 'trailhead');
const read = (rel) => fs.readFileSync(path.join(plugin, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const inbox = read('skills/trailhead-chart/references/inbox.md');
const commands = read('skills/_shared/substrate-commands.md');
const substrate = read('skills/_shared/substrate.md');
const reference = read('skills/_shared/configuration-reference.md');
const lineOf = (text, re) => (text.split('\n').find((l) => re.test(l)) || '');

// Four sections, by descriptive name.
ok('inbox.md presents four sections', inbox.includes('presents **four sections**') && !inbox.includes('presents **three sections**'));
ok('inbox.md has the Waiting on the reporter section', inbox.includes('**Waiting on the reporter.**'));
ok('the waiting section reads through the helper with the templates lookup', /trailhead-inbox-needs-info\.js --repo <owner\/name> --config-root <project root>/.test(inbox) && inbox.includes('same three-dir lookup as `trailhead-work-state.js`'));
ok('a failed helper never guesses answered or timed out', /never guess which are answered or timed out/.test(inbox));
ok('the proposal list covers the waiting section', /^For each issue in the first three sections \(incoming issues, waiting on the reporter, parked fog/m.test(inbox));

// The Needs info move.
const needsInfo = inbox.slice(inbox.indexOf('- **Needs info.**'));
ok('needs info: question posted first, then the label', /post the question \*\*first\*\*, then add `trailhead:needs-info`/.test(needsInfo));
ok('needs info: ensures the label idempotently', needsInfo.includes('gh label create trailhead:needs-info --color FBCA04') && needsInfo.includes('2>/dev/null || true'));
ok('resurfacing only on a reporter comment after the label', /only when the reporter comments after the label/.test(needsInfo));
ok('every move on an answered issue drops the label first', /dropping `trailhead:needs-info` first/.test(needsInfo));
ok('Ask again removes and re-adds the label', /\*\*Ask again\*\*[^\n]*removes and re-adds the label/.test(needsInfo));
ok('Keep waiting removes and re-adds the label, stating what a failure leaves', /\*\*Keep waiting\*\* removes and re-adds the label/.test(needsInfo) && /A failed removal keeps the old clock, so the offer returns next run; a failed re-add leaves the issue in the incoming queue/.test(needsInfo));
ok('a timeout is only an offer, never an automatic close', /only \*\*offered\*\* for closing/.test(needsInfo) && /never closed automatically/.test(needsInfo));
ok('the label comes off before the close', /remove the label, \*\*then\*\* `gh issue close <n> --reason "not planned"/.test(needsInfo));
ok('the close message follows ticket.language and asks for a new issue', needsInfo.includes('`config.ticket.language`') && needsInfo.includes('asks for a new issue linking this one'));
ok('failed steps are reported with the state left behind', /Any failed step of a move is reported naming the issue and the state it was left in/.test(needsInfo));
ok('the direct /trailhead:inbox <n> path triages whatever the state', /`\/trailhead:inbox <n>` on a needs-info issue triages it directly, whatever its state/.test(needsInfo));
ok('inbox.md has no em-dash', !inbox.includes(String.fromCharCode(8212)));

// The label set.
const firstUse = lineOf(commands, /^1\. Create any missing labels/);
ok('first-use setup lists the label among twenty-two', firstUse.includes('all twenty-two:') && firstUse.includes('`trailhead:needs-info`'));
ok('substrate-commands.md has the idempotent ensure line', commands.includes('gh label create trailhead:needs-info --color FBCA04 --description "Waiting on the reporter: back in the inbox when they answer" 2>/dev/null || true'));
ok('substrate.md documents the state label and the count', substrate.includes('**`trailhead:needs-info`**') && substrate.includes('twenty-two labels'));
ok('the labels guard exempts it (not a ticket)', /EXEMPT = \[[^\]]*'trailhead:needs-info'/.test(fs.readFileSync(path.join(plugin, 'hooks', 'trailhead-labels-guard.js'), 'utf8')));
ok('the label-guard Action strips any trailhead:* by prefix, so it needs no change', /label\.startsWith\('trailhead:'\)/.test(fs.readFileSync(path.join(root, '.github', 'workflows', 'trailhead-label-guard.yml'), 'utf8')));

// Config.
ok('configuration-reference documents inbox.needs_info_days, default 14', /\| `inbox\.needs_info_days` \| positive integer \(\*\*`14`\*\*\)/.test(reference) && reference.includes('**inbox.needs_info_days.**'));

// README mirror and site pages.
for (const f of ['README.md', 'README.it.md', 'site/src/content/docs/docs/configuration.mdx']) {
  ok(`${f} documents inbox.needs_info_days`, fs.readFileSync(path.join(root, f), 'utf8').includes('`inbox.needs_info_days`'));
}
for (const f of ['README.md', 'README.it.md', 'site/src/content/docs/docs/concepts.md']) {
  ok(`${f} lists the needs-info state label`, fs.readFileSync(path.join(root, f), 'utf8').includes('`needs-info` ('));
}
ok('chart.md shows four sections', fs.readFileSync(path.join(root, 'site/src/content/docs/docs/commands/chart.md'), 'utf8').includes('Shows four sections by name'));
ok('this test has no em-dash', !fs.readFileSync(__filename, 'utf8').includes(String.fromCharCode(8212)));

console.log(`inbox-needs-info-docs.test.js: ${passed} checks passed`);
