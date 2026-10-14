#!/usr/bin/env node
// Tests for templates/trailhead-report-status.js. Run: node report-status.test.js
// No framework: plain asserts, same style as work-state.test.js.
//
// Layers covered:
//   1. checkReport() as a table, for both techniques (#250).
//   2. The vocabulary equals the tokens the technique files define.
//   3. The CLI: --file, stdin, one JSON line, exit codes.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-report-status.js');
const { checkReport, TOKENS } = require(scriptPath);
const techDir = path.resolve(__dirname, '..', '..', 'skills', '_shared', 'techniques');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const K = 'critical: 0 · warning: 1 · info: 2'; // the counts line
const V = 'verify';
const C = 'code-review';

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
];

for (const [name, technique, input, expected] of rows) {
  const r = checkReport(input, technique);
  const [action, verdict, problem, normalised] = expected;
  ok(`${technique} / ${name}: exactly the four keys`, JSON.stringify(Object.keys(r)) === JSON.stringify(['action', 'verdict', 'problem', 'report']));
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

// --- misuse ---------------------------------------------------------------------
ok('checkReport: unknown technique throws', (() => { try { checkReport('status: met', 'plan'); } catch (e) { return true; } return false; })());
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
  ok('cli --file accept: one JSON line with the four keys', !!j && JSON.stringify(Object.keys(j)) === JSON.stringify(['action', 'verdict', 'problem', 'report']));
  ok('cli --file accept: values', j.action === 'accept' && j.verdict === 'met' && j.problem === null && j.report === 'status: met\nbody\n');
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
const usageErrors = [
  ['no technique', ['--file', file('d.md', 'status: met')]],
  ['unknown technique', ['--technique', 'plan', '--file', file('e.md', 'status: met')]],
  ['technique without a value', ['--technique']],
  ['unknown flag', ['--technique', 'verify', '--bogus', 'x', '--file', file('f.md', 'status: met')]],
  ['--file without a value', ['--technique', 'verify', '--file']],
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
