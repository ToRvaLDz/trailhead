#!/usr/bin/env node
// Tests for templates/trailhead-report-status.js. Run: node report-status.test.js
// No framework: plain asserts, same style as work-state.test.js.
//
// Layers covered:
//   1. checkReport() as a table, for the review techniques (#250).
//   2. The same for the field families: executor, fix, plan, debug, research,
//      codebase-map (#249): fields, body, the fields problem.
//   3. The vocabulary equals the tokens the technique files define, and the field
//      contracts equal what scripts/agent-blocks.md states.
//   4. The CLI: --file, stdin, one JSON line, exit codes.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-report-status.js');
const { checkReport, TOKENS, CONTRACTS, FAMILY_OF, VERIFY_CLASSES } = require(scriptPath);
const techDir = path.resolve(__dirname, '..', '..', 'skills', '_shared', 'techniques');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const K = 'critical: 0 · warning: 1 · info: 2'; // the counts line
const K1 = 'critical: 1 · warning: 0 · info: 0';
const K2 = 'critical: 2 · warning: 1 · info: 0';
const V = 'verify';
const C = 'code-review';
const KEYS = ['action', 'verdict', 'problem', 'report', 'fields', 'body'];

// [name, technique, input, expected]; expected = [action, verdict, problem] and,
// for a normalise row, the exact normalised report as a fourth element.
const rows = [
  // --- accept ---
  ['verify met, exact', V, 'status: met\nbody\n', ['accept', 'met', null]],
  ['verify gaps_found, exact', V, 'status: gaps_found\n- claim 2 unmet\n', ['accept', 'gaps_found', null]],
  ['verify inconclusive, exact', V, 'status: inconclusive\nreason: unrunnable-check\n', ['accept', 'inconclusive', null]],
  ['verify status only, no newline', V, 'status: met', ['accept', 'met', null]],
  ['verify ignores a counts-looking line', V, `status: met\n${K}\nbody`, ['accept', 'met', null]],
  ['verify does not need a counts line', V, 'status: met\nbody', ['accept', 'met', null]],
  ['code-review clean with counts on line 2', C, `status: clean\n${K}\nledger\n`, ['accept', 'clean', null]],
  ['code-review issues_found with counts on line 2', C, `status: issues_found\n${K}\nC1 open\n`, ['accept', 'issues_found', null]],

  // --- normalise: the same single token in another layout ---
  ['status on line 3 with bold decoration and upper case token', V, 'Intro\n\n**Status:** GAPS_FOUND\nbody',
    ['normalise', 'gaps_found', null, 'status: gaps_found\nIntro\n\nbody']],
  ['heading decoration', V, '## Status: met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['list bullet', V, '- status: met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['star bullet and bold', V, '* **status**: met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['backtick decoration', V, '`status: met`\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['underscore decoration', V, '__status__: met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['capitalised label and token', V, 'Status: Met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['hyphen for underscore', V, 'status: gaps-found\nbody', ['normalise', 'gaps_found', null, 'status: gaps_found\nbody']],
  ['space for underscore', C, `status: issues found\n${K}\nbody`, ['normalise', 'issues_found', null, `status: issues_found\n${K}\nbody`]],
  ['space before the colon', V, 'status : met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['two-space indent', V, '  status: met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['trailing spaces', V, 'status: met   \nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['leading blank lines', V, '\n\nstatus: met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['a blank line after the status line is kept', V, 'Status: Met\n\nbody', ['normalise', 'met', null, 'status: met\n\nbody']],
  ['CRLF line endings', V, 'status: met\r\nbody\r\n', ['normalise', 'met', null, 'status: met\nbody\n']],
  ['lone trailing CR is a line ending', V, 'status: met\r', ['normalise', 'met', null, 'status: met\n']],
  ['BOM before an exact status line', V, '﻿status: met\nbody', ['normalise', 'met', null, 'status: met\nbody']],
  ['BOM + exact status: clean + counts on line 2', C, `﻿status: clean\n${K}\nbody`, ['normalise', 'clean', null, `status: clean\n${K}\nbody`]],
  ['status not first', V, 'intro\nstatus: met', ['normalise', 'met', null, 'status: met\nintro']],
  ['repeated same token keeps one at line 1', V, 'status: met\nbody\nstatus: met', ['normalise', 'met', null, 'status: met\nbody']],
  ['repeated same token in different case', V, 'status: met\nbody\nStatus: MET\ntail', ['normalise', 'met', null, 'status: met\nbody\ntail']],
  ['status inside a code fence is ignored', V, 'x\n```\nstatus: PASS\n```\nstatus: met',
    ['normalise', 'met', null, 'status: met\nx\n```\nstatus: PASS\n```']],
  ['status inside a tilde fence is ignored', V, '~~~\nstatus: gaps_found\n~~~\nstatus: met',
    ['normalise', 'met', null, 'status: met\n~~~\nstatus: gaps_found\n~~~']],
  ['blockquote status is ignored, real one wins', V, '> status: gaps_found\nstatus: met',
    ['normalise', 'met', null, 'status: met\n> status: gaps_found']],
  ['indented status is ignored, unindented valid one wins', V, '    status: PASS\nstatus: met',
    ['normalise', 'met', null, 'status: met\n    status: PASS']],
  ['tab-indented status is ignored, unindented valid one wins', V, '\tstatus: PASS\nstatus: met',
    ['normalise', 'met', null, 'status: met\n\tstatus: PASS']],
  ['code-review heading between status and counts', C, `status: clean\n## Findings\n${K}\nbody`,
    ['normalise', 'clean', null, `status: clean\n${K}\n## Findings\nbody`]],
  ['code-review counts further down', C, `status: clean\nledger\n${K}`, ['normalise', 'clean', null, `status: clean\n${K}\nledger`]],
  ['code-review counts with decoration on line 2', C, `status: clean\n**${K}**\nbody`, ['normalise', 'clean', null, `status: clean\n${K}\nbody`]],
  ['code-review both lines out of place', C, `ledger\n${K}\n**Status:** ISSUES_FOUND\nbody`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K}\nledger\nbody`]],
  ['verify leaves a counts-looking line where it is', V, `intro\n${K}\nStatus: met`, ['normalise', 'met', null, `status: met\nintro\n${K}`]],

  // --- reask: missing ---
  ['empty', V, '', ['reask', null, 'missing']],
  ['whitespace only', V, '  \n\t\n\n', ['reask', null, 'missing']],
  ['no status line', V, 'The change looks fine.\n', ['reask', null, 'missing']],
  ['status only inside a blockquote', V, '> status: met\nbody', ['reask', null, 'missing']],
  ['status only inside a code fence', V, '```\nstatus: met\n```\n', ['reask', null, 'missing']],
  ['status only in an unterminated fence', V, 'text\n```\nstatus: met\n', ['reask', null, 'missing']],
  ['only candidate indented 4 spaces', V, '    status: met\n', ['reask', null, 'missing']],
  ['only candidate indented by a tab', V, '\tstatus: met\n', ['reask', null, 'missing']],
  ['status mid-sentence is not a status line', V, 'Final status: met\n', ['reask', null, 'missing']],
  ['code-review with no status', C, `${K}\nbody`, ['reask', null, 'missing']],

  // --- reask: unknown-token ---
  ['PASS', V, 'status: PASS\n', ['reask', null, 'unknown-token']],
  ['OK', V, 'status: OK\n', ['reask', null, 'unknown-token']],
  ['LGTM', C, `status: LGTM\n${K}\n`, ['reask', null, 'unknown-token']],
  ['FAIL', V, 'status: FAIL\n', ['reask', null, 'unknown-token']],
  ['done', V, 'status: done\n', ['reask', null, 'unknown-token']],
  ['empty token', V, 'status:\nbody', ['reask', null, 'unknown-token']],
  ['the other technique token (verify gets clean)', V, 'status: clean\n', ['reask', null, 'unknown-token']],
  ['the other technique token (code-review gets met)', C, `status: met\n${K}\n`, ['reask', null, 'unknown-token']],
  ['token with a trailing remark', V, 'status: met (5 claims)\n', ['reask', null, 'unknown-token']],
  ['two different invalid tokens', V, 'status: PASS\nstatus: OK', ['reask', null, 'unknown-token']],
  ['bad token and no counts line', C, 'status: LGTM\nbody', ['reask', null, 'unknown-token']],

  // --- reask: conflicting ---
  ['two different valid tokens', V, 'status: met\nstatus: gaps_found\n', ['reask', null, 'conflicting']],
  ['valid next to invalid', V, 'status: met\nstatus: PASS\n', ['reask', null, 'conflicting']],
  ['invalid first, then valid', V, 'status: PASS\nbody\nstatus: met\n', ['reask', null, 'conflicting']],
  ['code-review differing tokens', C, `status: clean\n${K}\nstatus: issues_found\n`, ['reask', null, 'conflicting']],
  ['conflicting outranks a missing counts line', C, 'status: clean\nstatus: issues_found\n', ['reask', null, 'conflicting']],

  // --- reask: counts (code-review only) ---
  ['counts line missing', C, 'status: clean\nbody\n', ['reask', null, 'counts']],
  ['counts line malformed', C, 'status: clean\ncritical: x · warning: 0 · info: 0\n', ['reask', null, 'counts']],
  ['two counts lines', C, `status: clean\n${K}\nbody\n${K}\n`, ['reask', null, 'counts']],
  ['two different counts lines', C, `status: clean\n${K}\ncritical: 1 · warning: 1 · info: 2\n`, ['reask', null, 'counts']],
  ['counts only inside a code fence', C, `status: clean\n\`\`\`\n${K}\n\`\`\`\n`, ['reask', null, 'counts']],

  // --- verdict vs content: code-review fails closed on an unclosed Critical ---
  ['clean with critical 2 and no ledger (ticket repro)', C, `status: clean\n${K2}\n\n- critical: SQL injection\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K2}\n\n- critical: SQL injection\n`]],
  ['clean, critical 1, C1 fixed', C, `status: clean\n${K1}\nC1 fixed (abc123)\n`, ['accept', 'clean', null]],
  ['clean, critical 1, C1 deferred', C, `status: clean\n${K1}\n- C1: deferred → #12\n`, ['accept', 'clean', null]],
  ['clean, critical 1, C1 accepted', C, `status: clean\n${K1}\nC1 accepted: false positive\n`, ['accept', 'clean', null]],
  ['clean, critical 2, only C1 closed', C, `status: clean\n${K2}\nC1 fixed (a)\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K2}\nC1 fixed (a)\n`]],
  ['clean, critical 1, C1 open', C, `status: clean\n${K1}\nC1 open\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K1}\nC1 open\n`]],
  ['clean, critical 1, C1 fixed and C2 open', C, `status: clean\n${K1}\nC1 fixed (a)\nC2 open\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K1}\nC1 fixed (a)\nC2 open\n`]],
  ['clean, critical 1, only a reclassified pointer', C, `status: clean\n${K1}\nC1 reclassified as W3\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K1}\nC1 reclassified as W3\n`]],
  ['clean, critical 1, ledger line only inside a fence', C, `status: clean\n${K1}\n\`\`\`\nC1 fixed (a)\n\`\`\`\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K1}\n\`\`\`\nC1 fixed (a)\n\`\`\`\n`]],
  ['clean, critical 2, a repeated C1 line counts once', C, `status: clean\n${K2}\nC1 fixed (a)\nc1 fixed (b)\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K2}\nC1 fixed (a)\nc1 fixed (b)\n`]],
  ['finding prose with open after a closed ledger line stays clean', C, `status: clean\n${K1}\nC1: fixed (abc)\nC1 file.js:3 handler leaves the socket open\n`, ['accept', 'clean', null]],
  ['open redirect prose with a fixed ledger stays clean', C, `status: clean\n${K1}\nC1 fixed (abc)\nC1 open redirect in login.js:9\n`, ['accept', 'clean', null]],
  ['a lone fixed-size prose line does not close the Critical', C, `status: clean\n${K1}\nC1 fixed-size buffer overflow in x.js:3: open\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K1}\nC1 fixed-size buffer overflow in x.js:3: open\n`]],
  ['bold id and en-dash separator ledger line', C, `status: clean\n${K1}\n- **C1** – fixed (abc)\n`, ['accept', 'clean', null]],
  ['verify subclass is not a class line', V, 'status: met\n- a, subclass: unmet\n', ['accept', 'met', null]],
  ['an unparsed open line for an uncounted Critical fails closed', C, `status: clean\n${K2}\nC1 fixed (a)\nC2 fixed (b)\nC3 open because x\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K2}\nC1 fixed (a)\nC2 fixed (b)\nC3 open because x\n`]],
  ['em dash separator closes the Critical', C, `status: clean\n${K1}\nC1 ${String.fromCharCode(0x2014)} fixed (abc)\n`, ['accept', 'clean', null]],
  ['still open fails closed', C, `status: clean\n${K1}\nC1: still open\nC2 fixed (a)\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K1}\nC1: still open\nC2 fixed (a)\n`]],
  ['bracketed open fails closed', C, `status: clean\n${K1}\nC1 [open]\nC2 fixed (a)\n`,
    ['normalise', 'issues_found', null, `status: issues_found\n${K1}\nC1 [open]\nC2 fixed (a)\n`]],
  ['a reclassified Critical does not gate the rest', C, `status: clean\n${K1}\nC1 reclassified as W3\nC2 fixed (a)\n`, ['accept', 'clean', null]],
  ['clean, critical 0, warnings open never gate', C, `status: clean\n${K}\nW1 open\n`, ['accept', 'clean', null]],
  ['issues_found is never changed', C, `status: issues_found\n${K1}\nC1 fixed (a)\n`, ['accept', 'issues_found', null]],

  // --- verdict vs content: verify raises the tag to the highest claim class ---
  ['verify met with a met claim', V, 'status: met\n- claim 1, class: met\n', ['accept', 'met', null]],
  ['verify met with an unmet claim', V, 'status: met\n- Claim 2: login wired, class: unmet\n',
    ['normalise', 'gaps_found', null, 'status: gaps_found\n- Claim 2: login wired, class: unmet\n']],
  ['verify met with a partial claim', V, 'status: met\n- claim 1, class: partial\n',
    ['normalise', 'gaps_found', null, 'status: gaps_found\n- claim 1, class: partial\n']],
  ['verify met with an inconclusive claim', V, 'status: met\n- claim 1, class: inconclusive\n  reason: unrunnable-check\n',
    ['normalise', 'inconclusive', null, 'status: inconclusive\n- claim 1, class: inconclusive\n  reason: unrunnable-check\n']],
  ['verify met with inconclusive and unmet', V, 'status: met\n- a, class: inconclusive\n- b, class: unmet\n',
    ['normalise', 'gaps_found', null, 'status: gaps_found\n- a, class: inconclusive\n- b, class: unmet\n']],
  ['verify inconclusive with an unmet claim', V, 'status: inconclusive\n- b, class: unmet\n',
    ['normalise', 'gaps_found', null, 'status: gaps_found\n- b, class: unmet\n']],
  ['verify gaps_found with only met claims stays', V, 'status: gaps_found\n- a, class: met\n', ['accept', 'gaps_found', null]],
  ['verify inconclusive with only met claims stays', V, 'status: inconclusive\n- a, class: met\n', ['accept', 'inconclusive', null]],
  ['verify class line inside a fence is ignored', V, 'status: met\n```\n- a, class: unmet\n```\n', ['accept', 'met', null]],
  ['verify class line inside a blockquote is ignored', V, 'status: met\n> - a, class: unmet\n', ['accept', 'met', null]],
  ['verify upper-case class counts', V, 'status: met\n- a, Class: UNMET\n',
    ['normalise', 'gaps_found', null, 'status: gaps_found\n- a, Class: UNMET\n']],
];

for (const [name, technique, input, expected] of rows) {
  const r = checkReport(input, technique);
  const [action, verdict, problem, normalised] = expected;
  ok(`${technique} / ${name}: exactly the six keys`, JSON.stringify(Object.keys(r)) === JSON.stringify(KEYS));
  ok(`${technique} / ${name}: fields ${r.action === 'reask' ? 'null on reask' : '{} for a review'}`, r.action === 'reask' ? r.fields === null : JSON.stringify(r.fields) === '{}');
  ok(`${technique} / ${name}: body is null`, r.body === null);
  ok(`${technique} / ${name}: action ${action}`, r.action === action);
  ok(`${technique} / ${name}: verdict ${verdict}`, r.verdict === verdict);
  ok(`${technique} / ${name}: problem ${problem}`, r.problem === problem);
  ok(`${technique} / ${name}: problem is null iff not a reask`, (r.problem === null) === (r.action !== 'reask'));
  if (action === 'normalise') {
    ok(`${technique} / ${name}: normalised report`, r.report === normalised);
    const again = checkReport(r.report, technique);
    ok(`${technique} / ${name}: the normalised report is accepted as is`, again.action === 'accept' && again.verdict === verdict && again.report === r.report);
  } else {
    ok(`${technique} / ${name}: report is the original text`, r.report === input);
  }
}

// --- the field families (#249) ---------------------------------------------------
const EX = 'executor';
const fullImpl = (status, blockers, extra = '') =>
  `status: ${status}\ncommits:\nabc1234 feat: x\ndef5678 test: y\ntests: npm test, green\ndeviations: none\nblockers: ${blockers}\n${extra}`;
// [name, technique, input, expected]; expected = [action, verdict, problem, fields-or-null, body, report-for-normalise]
const frows = [
  // --- accept ---
  ['done, fields parsed', EX, fullImpl('done', 'none'), ['accept', 'done', null,
    { commits: 'abc1234 feat: x\ndef5678 test: y', tests: 'npm test, green', deviations: 'none', blockers: 'none' }, null]],
  ['fix uses the implementing contract', 'fix', fullImpl('done', 'none'), ['accept', 'done', null, null, null]],
  ['done with blockers: empty', EX, 'status: done\ncommits: a b\ntests: t\ndeviations:\nblockers:\n', ['accept', 'done', null,
    { commits: 'a b', tests: 't', deviations: '', blockers: '' }, null]],
  ['partial with a blocker', EX, fullImpl('partial', 'infeasible: the gradient header'), ['accept', 'partial', null, null, null]],
  ['blocked, multi-line blockers', EX, fullImpl('blocked', '\n- pkg-x: `npm i pkg-x`, first seen yesterday\n- foreign change in a.js'), ['accept', 'blocked', null, null, null]],
  ['optional fields are parsed', EX, fullImpl('done', 'none', 'fidelity:\n- header -> reproduced\nsurfaced scope: a follow-up\n'), ['accept', 'done', null, null, null]],
  ['investigating found', 'research', 'status: found\nanswer: use X\nevidence: https://a.example/doc\nopen questions: none\n', ['accept', 'found', null,
    { answer: 'use X', evidence: 'https://a.example/doc', 'open questions': 'none' }, null]],
  ['debug inconclusive keeps open questions', 'debug', 'status: inconclusive\nanswer: not yet\nevidence: a.js:3\nopen questions: which env?\n', ['accept', 'inconclusive', null, null, null]],
  ['codebase-map needs_input with questions', 'codebase-map', 'status: needs_input\nanswer: partial\nevidence: a.js:1\nopen questions: which root?\n', ['accept', 'needs_input', null, null, null]],
  ['plan ready, body is the rest', 'plan', 'status: ready\n\n## Steps\n1. a\n2. b\n\nVerification: x\n', ['accept', 'ready', null, {}, '## Steps\n1. a\n2. b\n\nVerification: x']],
  ['plan needs_input', 'plan', 'status: needs_input\nquestions:\n1. Which db?\n2. Keep v1?\n', ['accept', 'needs_input', null, { questions: '1. Which db?\n2. Keep v1?' }, null]],
  ['grilling question round', 'grill', 'status: question\nsettled: none\nfrontier: Q1, Q2\nquestion: 1. Which db?\nrecommended: A\nWeak point: it costs more.\namendments: none\nconflicts: none\n', ['accept', 'question', null,
    { settled: 'none', frontier: 'Q1, Q2', question: '1. Which db?', recommended: 'A\nWeak point: it costs more.', amendments: 'none', conflicts: 'none' }, null]],
  ['grilling review round', 'grill', 'status: review\nsettled: Q1 A, because x\nfrontier: none\namendments: Q1: tighten the wording\nconflicts: Q1 vs Q2: reconcile them. Weak point: none\n', ['accept', 'review', null, null, null]],
  // --- normalise: layout, fields intact ---
  ['bold label and token, bullets', EX, '**Status:** DONE\n- **commits:** abc1234 feat: x\n- tests: ok\n- deviations: none\n- blockers: none\n', ['normalise', 'done', null,
    { commits: 'abc1234 feat: x', tests: 'ok', deviations: 'none', blockers: 'none' }, null,
    'status: done\n- **commits:** abc1234 feat: x\n- tests: ok\n- deviations: none\n- blockers: none\n']],
  ['labels in any case and with spaces', 'debug', 'Intro\nStatus: Found\nAnswer: a\nEVIDENCE: e\nOpen Questions: none', ['normalise', 'found', null,
    { answer: 'a', evidence: 'e', 'open questions': 'none' }, null, 'status: found\nIntro\nAnswer: a\nEVIDENCE: e\nOpen Questions: none']],
  ['plan ready, status not first: body without the status line', 'plan', 'Here is the plan.\n\nstatus: ready\nStep 1\n', ['normalise', 'ready', null, {}, 'Here is the plan.\n\nStep 1',
    'status: ready\nHere is the plan.\n\nStep 1\n']],
  ['a label inside a code fence is not a field', EX, 'status: done\ncommits: a b\ntests: t\ndeviations: none\n```\nblockers: x\n```\nblockers: none\n', ['accept', 'done', null,
    { commits: 'a b', tests: 't', deviations: 'none\n```\nblockers: x\n```', blockers: 'none' }, null]],
  ['a label in a blockquote is not a field', EX, 'status: done\ncommits: a\ntests: t\ndeviations: none\n> blockers: x\nblockers: none\n', ['accept', 'done', null, null, null]],
  ['a label that is not in the closed list is part of the value', EX, 'status: done\ncommits: a\nnote: x\ntests: t\ndeviations: none\nblockers: none\n', ['accept', 'done', null,
    { commits: 'a\nnote: x', tests: 't', deviations: 'none', blockers: 'none' }, null]],

  // --- reask: the status problems keep precedence over fields ---
  ['missing status', EX, 'commits: a\ntests: t\ndeviations: none\nblockers: none\n', ['reask', null, 'missing']],
  ['conflicting outranks fields', EX, 'status: done\nstatus: blocked\nblockers: none\n', ['reask', null, 'conflicting']],
  ['unknown token outranks fields', EX, 'status: met\ncommits: a\n', ['reask', null, 'unknown-token']],
  ['a review token is unknown for a field technique', 'plan', 'status: met\n', ['reask', null, 'unknown-token']],
  ['an implementing token is unknown for investigating', 'research', 'status: done\n', ['reask', null, 'unknown-token']],
  // --- reask: fields ---
  ['missing required field (tests)', EX, 'status: done\ncommits: a\ndeviations: none\nblockers: none\n', ['reask', null, 'fields']],
  ['no fields at all', 'debug', 'status: found\nThe cause is X.\n', ['reask', null, 'fields']],
  ['done with blockers', EX, fullImpl('done', 'a flagged package'), ['reask', null, 'fields']],
  ['partial without blockers', EX, fullImpl('partial', 'none'), ['reask', null, 'fields']],
  ['blocked with an empty blockers', EX, fullImpl('blocked', ''), ['reask', null, 'fields']],
  ['needs_input without open questions', 'research', 'status: needs_input\nanswer: a\nevidence: e\nopen questions: none\n', ['reask', null, 'fields']],
  ['needs_input with an empty open questions', 'debug', 'status: needs_input\nanswer: a\nevidence: e\nopen questions:\n', ['reask', null, 'fields']],
  ['plan needs_input without questions', 'plan', 'status: needs_input\nsome prose\n', ['reask', null, 'fields']],
  ['plan needs_input with none questions', 'plan', 'status: needs_input\nquestions: none\n', ['reask', null, 'fields']],
  ['plan ready with an empty body', 'plan', 'status: ready\n\n  \n', ['reask', null, 'fields']],
  ['plan ready with only a status line', 'plan', 'status: ready', ['reask', null, 'fields']],
  ['a fenced status line inside a plan body is part of the body', 'plan', 'status: ready\n\nA feature about statuses:\n```\nstatus: pending\n```\nDone.\n', ['accept', 'ready', null, {},
    'A feature about statuses:\n```\nstatus: pending\n```\nDone.']],
  ['a blockquoted status line inside an answer is ignored', 'research', 'status: found\nanswer: see\n> status: pending\nevidence: e\nopen questions: none\n', ['accept', 'found', null, null, null]],
  ['prose after the last field becomes its value, so a done report reasks', EX, fullImpl('done', 'none', 'Note: hi\n'), ['reask', null, 'fields']],
  ['grilling question without recommended', 'grill', 'status: question\nsettled: none\nfrontier: Q1\nquestion: 1. Which db?\namendments: none\nconflicts: none\n', ['reask', null, 'fields']],
  ['grilling question with an empty question', 'grill', 'status: question\nsettled: none\nfrontier: Q1\nquestion: none\nrecommended: A\namendments: none\nconflicts: none\n', ['reask', null, 'fields']],
  ['grilling question with conflicts', 'grill', 'status: question\nsettled: none\nfrontier: Q1\nquestion: 1. Which db?\nrecommended: A\namendments: none\nconflicts: Q1 vs Q2\n', ['reask', null, 'fields']],
  ['grilling question with amendments', 'grill', 'status: question\nsettled: none\nfrontier: Q1\nquestion: 1. Which db?\nrecommended: A\namendments: Q1: x\nconflicts: none\n', ['reask', null, 'fields']],
  ['grilling review with a frontier', 'grill', 'status: review\nsettled: Q1 A\nfrontier: Q2\namendments: none\nconflicts: none\n', ['reask', null, 'fields']],
  ['grilling review with a question', 'grill', 'status: review\nsettled: Q1 A\nfrontier: none\nquestion: 2. More?\namendments: none\nconflicts: none\n', ['reask', null, 'fields']],
  ['grilling review without amendments', 'grill', 'status: review\nsettled: Q1 A\nfrontier: none\nconflicts: none\n', ['reask', null, 'fields']],
  ['grilling: ready is an unknown token', 'grill', 'status: ready\nsettled: none\nfrontier: none\namendments: none\nconflicts: none\n', ['reask', null, 'unknown-token']],
  ['the same label twice', EX, fullImpl('done', 'none', 'tests: again\n'), ['reask', null, 'fields']],
];
for (const [name, technique, input, expected] of frows) {
  const r = checkReport(input, technique);
  const [action, verdict, problem, fields, body, normalised] = expected;
  const t = `${technique} / ${name}`;
  ok(`${t}: exactly the six keys`, JSON.stringify(Object.keys(r)) === JSON.stringify(KEYS));
  ok(`${t}: action ${action}`, r.action === action);
  ok(`${t}: verdict ${verdict}`, r.verdict === verdict);
  ok(`${t}: problem ${problem}`, r.problem === problem);
  if (action === 'reask') {
    ok(`${t}: fields and body are null`, r.fields === null && r.body === null);
    ok(`${t}: report is the original text`, r.report === input);
    continue;
  }
  if (fields) ok(`${t}: fields`, JSON.stringify(r.fields) === JSON.stringify(fields));
  else ok(`${t}: fields is an object`, r.fields !== null && typeof r.fields === 'object');
  if (body !== undefined && (technique === 'plan' || body !== null)) ok(`${t}: body`, r.body === body);
  if (action === 'normalise') {
    ok(`${t}: normalised report`, r.report === normalised);
    const again = checkReport(r.report, technique);
    ok(`${t}: the normalised report is accepted as is, with the same fields and body`,
      again.action === 'accept' && again.report === r.report && JSON.stringify(again.fields) === JSON.stringify(r.fields) && again.body === r.body);
  } else {
    ok(`${t}: report is the original text`, r.report === input);
  }
}
{
  const r = checkReport(fullImpl('done', 'none', 'fidelity:\n- header -> reproduced\nsurfaced scope: a follow-up\n'), EX);
  ok('optional fidelity is multi-line', r.fields.fidelity === '- header -> reproduced');
  ok('optional surfaced scope is read', r.fields['surfaced scope'] === 'a follow-up');
  const b = checkReport(fullImpl('blocked', '\n- pkg-x: `npm i pkg-x`, first seen yesterday\n- foreign change in a.js'), EX);
  ok('multi-line blockers keep every entry', b.fields.blockers === '- pkg-x: `npm i pkg-x`, first seen yesterday\n- foreign change in a.js');
  ok('a report with an unterminated fence still parses its leading fields', checkReport('status: found\nanswer: a\nevidence: e\nopen questions: none\n```\nx', 'research').action === 'accept');
}

{
  const r = checkReport('status: review\nsettled: Q1 A\nfrontier: none\namendments: none\nconflicts: none\n', 'grill');
  ok('grill: Weak point is not a field label and body is null', r.body === null && !('weak point' in r.fields));
  const q = checkReport('status: question\nsettled: none\nfrontier: Q1\nquestion: 1. Which?\nrecommended: A\nWeak point: x\nWeak point: y\namendments: none\nconflicts: none\n', 'grill');
  ok('grill: two Weak point lines do not trigger a reask', q.action === 'accept' && q.body === null);
}

// --- misuse ---------------------------------------------------------------------
ok('checkReport: unknown technique throws', (() => { try { checkReport('status: met', 'bogus'); } catch (e) { return true; } return false; })());
ok('checkReport: missing technique throws', (() => { try { checkReport('status: met'); } catch (e) { return true; } return false; })());
ok('checkReport: a non-string report is treated as empty', checkReport(undefined, V).problem === 'missing');

// --- vocabulary equals the technique files --------------------------------------
const techniqueTokens = (file) => {
  const text = fs.readFileSync(path.join(techDir, file), 'utf8');
  return [...new Set([...text.matchAll(/`status: (\w+)`/g)].map((m) => m[1]))].sort();
};
ok('vocabulary: verify tokens equal the ones verify.md defines',
  JSON.stringify([...TOKENS.verify].sort()) === JSON.stringify(techniqueTokens('verify.md')) && TOKENS.verify.length === 3);
ok('vocabulary: code-review tokens equal the ones code-review.md defines',
  JSON.stringify([...TOKENS['code-review']].sort()) === JSON.stringify(techniqueTokens('code-review.md')) && TOKENS['code-review'].length === 2);

// --- the field contracts equal scripts/agent-blocks.md (#249) -----------------------
{
  const { parseSource } = require(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'sync-agent-blocks.js'));
  const blocks = parseSource(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'agent-blocks.md'), 'utf8'));
  const words = (block, prefix) => {
    const line = block.split('\n').find((l) => l.startsWith(`- ${prefix}:`)) || '';
    return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  };
  // `- invariant: `a`, `b` => `field` non-empty.` -> { when, field, rule }
  const invariants = (block) => block.split('\n').filter((l) => l.startsWith('- invariant:')).map((l) => {
    const [lhs, rhs] = l.split('=>');
    return { when: [...lhs.matchAll(/`([^`]+)`/g)].map((m) => m[1]), field: /`([^`]+)`/.exec(rhs)[1], rule: /(non-empty|none)\.$/.exec(rhs)[1] };
  });
  for (const family of ['implementing', 'investigating', 'plan', 'grilling']) {
    const block = blocks[family];
    ok(`contracts: source defines the ${family} block`, typeof block === 'string');
    ok(`contracts: ${family} tokens equal the source`, JSON.stringify(CONTRACTS[family].tokens) === JSON.stringify(words(block, 'statuses')));
    ok(`contracts: ${family} required fields equal the source`, JSON.stringify(CONTRACTS[family].required) === JSON.stringify(words(block, 'required fields')));
    ok(`contracts: ${family} optional fields equal the source`, JSON.stringify(CONTRACTS[family].optional) === JSON.stringify(words(block, 'optional fields')));
    ok(`contracts: ${family} invariants equal the source`, JSON.stringify(CONTRACTS[family].invariants) === JSON.stringify(invariants(block)) && invariants(block).length > 0);
  }
  const { FAMILIES } = require(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'sync-agent-blocks.js'));
  for (const [technique, family] of Object.entries(FAMILY_OF)) {
    ok(`contracts: technique ${technique} maps to the family of trailhead-${technique} in the sync script`, FAMILIES[`trailhead-${technique}`] === family);
    ok(`contracts: TOKENS.${technique} are the ${family} tokens`, JSON.stringify(TOKENS[technique]) === JSON.stringify(CONTRACTS[family].tokens));
  }
  // the reviewing block names the verify class vocabulary and the closing dispositions
  const bullet = (block, prefix) => block.split('\n').find((l) => l.startsWith(`- ${prefix}:`)) || '';
  const classTokens = (text) => [...text.matchAll(/class: <([a-z|]+)>/g)].flatMap((m) => m[1].split('|'));
  ok('contracts: reviewing verify bullet names the checker class vocabulary',
    JSON.stringify(classTokens(bullet(blocks.reviewing, 'trailhead-verify'))) === JSON.stringify(VERIFY_CLASSES));
  const crBullet = bullet(blocks.reviewing, 'trailhead-code-review');
  ok('contracts: reviewing code-review bullet names the closing dispositions',
    ['fixed', 'deferred', 'accepted'].every((d) => new RegExp(`\\x60${d}\\x60`).test(crBullet)));
  const verifyDoc = fs.readFileSync(path.join(techDir, 'verify.md'), 'utf8');
  ok('contracts: verify.md names the same class vocabulary',
    classTokens(verifyDoc.replace(/class: ([a-z]+(?: \| [a-z]+)+)/g, (m, g) => `class: <${g.replace(/ \| /g, '|')}>`)).join() === VERIFY_CLASSES.join());
  ok('contracts: every non-review agent has a technique here',
    Object.entries(FAMILIES).filter(([, f]) => f !== 'reviewing').every(([a]) => FAMILY_OF[a.replace(/^trailhead-/, '')] !== undefined));
}

// --- CLI -------------------------------------------------------------------------
function cli(args, input) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], { input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-report-status-test-'));
const file = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };
const oneLine = (out) => { const lines = out.split('\n').filter(Boolean); return out.endsWith('\n') && lines.length === 1 ? JSON.parse(lines[0]) : null; };

{
  const r = cli(['--technique', 'verify', '--file', file('a.md', 'status: met\nbody\n')]);
  const j = oneLine(r.out);
  ok('cli --file accept: exit 0', r.code === 0);
  ok('cli --file accept: one JSON line with the six keys', !!j && JSON.stringify(Object.keys(j)) === JSON.stringify(KEYS));
  ok('cli --file accept: values', j.action === 'accept' && j.verdict === 'met' && j.problem === null && j.report === 'status: met\nbody\n');
  ok('cli --file accept: fields {} and body null for a review', JSON.stringify(j.fields) === '{}' && j.body === null);
}
{
  const r = cli(['--technique', 'plan', '--file', file('p.md', 'status: ready\n\nStep 1\n')]);
  const j = oneLine(r.out);
  ok('cli plan ready: exit 0, body is the plan', r.code === 0 && j.action === 'accept' && j.body === 'Step 1');
  const e = cli(['--technique', 'executor'], fullImpl('done', 'none'));
  const je = oneLine(e.out);
  ok('cli executor stdin: fields returned', e.code === 0 && je.action === 'accept' && je.fields.tests === 'npm test, green');
  const f = cli(['--technique', 'research'], 'status: needs_input\nanswer: a\nevidence: e\n');
  const jf = oneLine(f.out);
  ok('cli research: a fields reask, exit 0', f.code === 0 && jf.action === 'reask' && jf.problem === 'fields' && jf.fields === null);
}
{
  const r = cli(['--technique', 'verify', '--file', file('b.md', '**Status:** GAPS_FOUND\r\nbody\r\n')]);
  const j = oneLine(r.out);
  ok('cli --file normalise: exit 0', r.code === 0);
  ok('cli --file normalise: values', j.action === 'normalise' && j.verdict === 'gaps_found' && j.report === 'status: gaps_found\nbody\n');
}
{
  const r = cli(['--technique', 'verify', '--file', file('c.md', 'status: PASS\n')]);
  const j = oneLine(r.out);
  ok('cli --file reask: exit 0', r.code === 0);
  ok('cli --file reask: values', j.action === 'reask' && j.verdict === null && j.problem === 'unknown-token' && j.report === 'status: PASS\n');
}
{
  const r = cli(['--technique', 'code-review'], `status: clean\n${K}\nbody\n`);
  const j = oneLine(r.out);
  ok('cli stdin: exit 0', r.code === 0);
  ok('cli stdin: code-review accept', j.action === 'accept' && j.verdict === 'clean' && j.report === `status: clean\n${K}\nbody\n`);
}
{
  const r = cli(['--technique', 'code-review'], 'status: clean\nbody\n');
  const j = oneLine(r.out);
  ok('cli stdin: counts reask', r.code === 0 && j.action === 'reask' && j.problem === 'counts');
}
{
  const r = cli(['--technique', 'verify'], '');
  const j = oneLine(r.out);
  ok('cli stdin: empty input is a missing reask, exit 0', r.code === 0 && j.action === 'reask' && j.problem === 'missing');
}
{
  // A report over the 64 KB pipe buffer must come back whole through a pipe.
  const big = 'status: met\n' + 'x'.repeat(300000) + '\n';
  const r = cli(['--technique', 'verify'], big);
  const j = oneLine(r.out);
  ok('cli: a report over 64 KB arrives whole through a pipe', r.code === 0 && !!j && j.action === 'accept' && j.report === big);
  const f = cli(['--technique', 'verify', '--file', file('big.md', big)]);
  const jf = oneLine(f.out);
  ok('cli --file: a report over 64 KB arrives whole through a pipe', f.code === 0 && !!jf && jf.report === big);
}
const usageErrors = [
  ['no technique', ['--file', file('d.md', 'status: met')]],
  ['unknown technique', ['--technique', 'bogus', '--file', file('e.md', 'status: met')]],
  ['technique without a value', ['--technique']],
  ['unknown flag', ['--technique', 'verify', '--bogus', 'x', '--file', file('f.md', 'status: met')]],
  ['--file without a value', ['--technique', 'verify', '--file']],
  ['empty --file value', ['--technique', 'verify', '--file', '']],
  ['unreadable file', ['--technique', 'verify', '--file', path.join(tmp, 'nope.md')]],
];
for (const [name, args] of usageErrors) {
  const r = cli(args, 'status: met\n');
  let e = null;
  try { e = JSON.parse(r.err.trim()); } catch (_) { /* leave null */ }
  ok(`cli usage error (${name}): exit 2`, r.code === 2);
  ok(`cli usage error (${name}): nothing on stdout`, r.out === '');
  ok(`cli usage error (${name}): {"error": message} on stderr`, !!e && typeof e.error === 'string' && e.error.length > 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`report-status.test.js: ${passed} checks passed`);
