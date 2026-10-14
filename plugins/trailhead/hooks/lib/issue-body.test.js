#!/usr/bin/env node
// Tests for templates/trailhead-issue-body.js. Run: node issue-body.test.js
// No framework: plain asserts, same style as work-state.test.js.
//
// Layers covered:
//   1. Pure applyOp() on fixtures (sections, preamble, placeholder, remove).
//   2. guardedWrite() / main() against a fake tracker behind an injected `gh`
//      runner (the only system boundary mocked): fail-safe reads, optimistic
//      concurrency, the post-write conflict check, the secret scan.
//   3. End-to-end: the script itself with a fake `gh` first on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-issue-body.js');
const mod = require(scriptPath);
const { applyOp, guardedWrite, main, loadGuard } = mod;

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- fixtures ----------------------------------------------------------------
const MAP = [
  'Intro line for the map, long enough to look real.',
  '',
  '## Destination',
  'Somewhere good.',
  '',
  '## ✅ Decisions so far',
  '- [A thing #1](https://x/1): did it.',
  '- [Other #2](https://x/2): did that.',
  '  continued detail for two',
  '',
  '## Not yet specified',
  '- fog item',
  '',
].join('\n');

const EMPTY_DECISIONS = ['Intro line for the map, long enough.', '', '## Decisions so far', '_none yet_', '', '## Fog', '- x', ''].join('\n');

// --- applyOp: append ---------------------------------------------------------
{
  const r = applyOp(MAP, { kind: 'append', section: 'Decisions so far', line: '- [New #3](https://x/3): added.' });
  ok('append: ok, changed', !r.error && r.changed === true);
  const lines = r.body.split('\n');
  const i = lines.indexOf('  continued detail for two');
  ok('append: line lands after the last content line', lines[i + 1] === '- [New #3](https://x/3): added.');
  ok('append: blank separator before next heading kept', lines[i + 2] === '' && lines[i + 3] === '## Not yet specified');
  ok('append: emoji heading matched by plain name', /## ✅ Decisions so far/.test(r.body));
  ok('append: rest of the body untouched', r.body.replace('- [New #3](https://x/3): added.\n', '') === MAP);
}
{
  const r = applyOp(EMPTY_DECISIONS, { kind: 'append', section: 'Decisions so far', line: '- first' });
  ok('append: sole placeholder is dropped', !r.error && !/none yet/.test(r.body) && /## Decisions so far\n- first\n\n## Fog/.test(r.body));
}
{
  const body = ['Intro line for the map, long enough.', '', '## Decisions so far', '- a', '_none yet_', '', '## Fog', ''].join('\n');
  const r = applyOp(body, { kind: 'append', section: 'Decisions so far', line: '- b' });
  ok('append: placeholder kept when not the sole content', /_none yet_\n- b/.test(r.body));
}
{
  const body = ['Intro line for the map, long enough.', '', '## Decisions so far', '', '## Fog', ''].join('\n');
  const r = applyOp(body, { kind: 'append', section: 'Decisions so far', line: '- first' });
  ok('append: empty section gets a blank line then the entry', /## Decisions so far\n\n- first\n\n## Fog/.test(r.body));
}
{
  const body = 'Intro line long enough here.\n\n## Decisions so far\n- a';
  const r = applyOp(body, { kind: 'append', section: 'Decisions so far', line: '- b' });
  ok('append: last section without trailing newline', r.body === 'Intro line long enough here.\n\n## Decisions so far\n- a\n- b');
}
{
  const crlf = MAP.replace(/\n/g, '\r\n');
  const r = applyOp(crlf, { kind: 'append', section: 'Decisions so far', line: '- c' });
  ok('append: CRLF body keeps CRLF', !r.error && !/[^\r]\n/.test(r.body) && r.body.includes('- c\r\n'));
}
{
  const fenced = ['Intro line for the map, long enough.', '', '```', '## Decisions so far', '```', '', '## Decisions so far', '- a', ''].join('\n');
  const r = applyOp(fenced, { kind: 'append', section: 'Decisions so far', line: '- b' });
  ok('append: a heading inside a code fence is not a section', /- a\n- b\n/.test(r.body) && r.body.startsWith(fenced.slice(0, fenced.indexOf('- a'))));
}
{
  const r = applyOp(MAP, { kind: 'append', section: 'Nope', line: '- x' });
  ok('append: missing section is an error', typeof r.error === 'string' && /Nope/.test(r.error));
  const h3 = applyOp('Intro line long enough.\n\n### Decisions so far\n- a\n', { kind: 'append', section: 'Decisions so far', line: '- x' });
  ok('append: only ## headings count', typeof h3.error === 'string');
  const multi = applyOp(MAP, { kind: 'append', section: 'Decisions so far', line: 'a\nb' });
  ok('append: a multi-line --line is rejected', typeof multi.error === 'string');
}

// --- applyOp: preamble -------------------------------------------------------
{
  const body = ['> conventions header', '> second line', '', '## Facet', '- x', ''].join('\n');
  const r = applyOp(body, { kind: 'replace', section: ':preamble', text: '> new header\n> two\n' });
  ok('preamble replace: swaps the text before the first heading', r.body === ['> new header', '> two', '', '## Facet', '- x', ''].join('\n'));
  const a = applyOp(body, { kind: 'append', section: ':preamble', line: '> third' });
  ok('preamble append: after the last preamble line', a.body.startsWith('> conventions header\n> second line\n> third\n\n## Facet'));
  const none = applyOp('just text without headings', { kind: 'append', section: ':preamble', line: 'more' });
  ok('preamble: whole body when there is no heading', none.body === 'just text without headings\nmore');
}

// --- applyOp: replace --------------------------------------------------------
{
  const r = applyOp(MAP, { kind: 'replace', section: 'Not yet specified', text: '- new fog\n- more fog\n' });
  ok('replace: section content swapped, heading kept', /## Not yet specified\n\n- new fog\n- more fog\n$/.test(r.body) || /## Not yet specified\n- new fog\n- more fog\n/.test(r.body));
  ok('replace: other sections intact', r.body.includes('- [A thing #1](https://x/1): did it.') && !r.body.includes('- fog item'));
  const mid = applyOp(MAP, { kind: 'replace', section: 'Destination', text: 'Elsewhere.' });
  ok('replace: blank line before the next heading kept', /Elsewhere\.\n\n## ✅ Decisions so far/.test(mid.body));
  const empty = applyOp(MAP, { kind: 'replace', section: 'Destination', text: '' });
  ok('replace: empty text empties the section but keeps the heading', !empty.error && /## Destination\n\n## ✅ Decisions so far/.test(empty.body));
}

// --- applyOp: remove ---------------------------------------------------------
{
  const r = applyOp(MAP, { kind: 'remove', section: 'Decisions so far', match: 'Other #2' });
  ok('remove: drops the entry and its indented continuation', r.changed && !r.body.includes('Other #2') && !r.body.includes('continued detail'));
  ok('remove: neighbouring entry and spacing kept', r.body.includes('- [A thing #1](https://x/1): did it.\n\n## Not yet specified'));
  const none = applyOp(MAP, { kind: 'remove', section: 'Decisions so far', match: 'does not exist' });
  ok('remove: zero matches is a reported no-op', !none.error && none.changed === false && none.body === MAP && /no entry/.test(none.summary));
  const amb = applyOp(MAP, { kind: 'remove', section: 'Decisions so far', match: '#' });
  ok('remove: more than one match is ambiguous', typeof amb.error === 'string' && /ambiguous/.test(amb.error));
  const viaCont = applyOp(MAP, { kind: 'remove', section: 'Decisions so far', match: 'continued detail' });
  ok('remove: a match inside the continuation removes the whole entry', viaCont.changed && !viaCont.body.includes('Other #2'));
  const miss = applyOp(MAP, { kind: 'remove', section: 'Nope', match: 'x' });
  ok('remove: missing section is an error', typeof miss.error === 'string');
}

// --- fake tracker ------------------------------------------------------------
function makeTracker(init = {}) {
  const t = {
    body: init.body === undefined ? MAP : init.body,
    updatedAt: init.updatedAt || 'T1',
    edits: init.edits === undefined ? 3 : init.edits,
    writeDelta: init.writeDelta === undefined ? 1 : init.writeDelta,
    calls: [],
    writes: [],
    tmpSeen: [],
    viewFail: init.viewFail || 0, // number of leading `issue view` calls that fail
    views: 0,
    onView: init.onView || null, // (t, n) called before answering the n-th view
    beforeEdit: init.beforeEdit || null,
    onCount: init.onCount || null, // (t, n) called before answering the n-th edit-count read
    counts: 0,
    editFails: init.editFails || false,
    garbleReadback: init.garbleReadback || false,
    countFails: init.countFails || false,
  };
  t.externalEdit = (body) => { t.body = body; t.edits += 1; t.updatedAt = 'T' + (Number(t.updatedAt.slice(1)) + 1); };
  t.gh = (args) => {
    t.calls.push(args.join(' '));
    const sub = args.slice(0, 2).join(' ');
    if (sub === 'issue view') {
      t.views += 1;
      if (t.onView) t.onView(t, t.views);
      if (t.viewFail > 0) { t.viewFail -= 1; return { status: 1, stdout: '', stderr: 'HTTP 502' }; }
      if (t.viewRaw !== undefined) return { status: 0, stdout: t.viewRaw, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ body: t.body, updatedAt: t.updatedAt }), stderr: '' };
    }
    if (sub === 'issue edit') {
      const file = args[args.indexOf('--body-file') + 1];
      t.tmpSeen.push(file);
      if (t.beforeEdit) t.beforeEdit(t);
      if (t.editFails) return { status: 1, stdout: '', stderr: 'boom' };
      const text = fs.readFileSync(file, 'utf8');
      t.writes.push(text);
      t.body = t.garbleReadback ? text + '\nextra' : text;
      t.edits += t.writeDelta;
      t.updatedAt = 'T' + (Number(t.updatedAt.slice(1)) + 1);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (sub === 'api graphql') {
      t.counts += 1;
      if (t.onCount) t.onCount(t, t.counts);
      if (t.countFails) return { status: 1, stdout: '', stderr: 'graphql down' };
      return { status: 0, stdout: JSON.stringify({ data: { repository: { issue: { userContentEdits: { totalCount: t.edits } } } } }), stderr: '' };
    }
    if (sub === 'repo view') return { status: 0, stdout: 'o/r\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected: ' + args.join(' ') };
  };
  return t;
}

const fakeGuard = { scan: (text) => (/ghp_[A-Za-z0-9]{20,}/.test(text) ? 'github token' : null) };

function runMain(argv, t, extra = {}) {
  const chunks = [];
  const errChunks = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errChunks.push(String(s)); return true; };
  let code;
  try {
    code = main(argv, { gh: t.gh, stdout: { write: (s) => chunks.push(s) }, guard: fakeGuard, ...extra });
  } finally {
    process.stderr.write = realErr;
  }
  return { code, out: chunks.join(''), err: errChunks.join('') };
}

const APPEND = ['append', '--issue', '7', '--repo', 'o/r', '--section', 'Decisions so far', '--line', '- [New #3](https://x/3): added.'];

// --- happy path --------------------------------------------------------------
{
  const t = makeTracker();
  const r = runMain(APPEND, t);
  ok('append: exit 0', r.code === 0);
  ok('append: one line, never the body', r.out.split('\n').filter(Boolean).length === 1 && !r.out.includes('Intro line'));
  ok('append: the summary line', r.out.trim() === 'issue #7: appended 1 line to "Decisions so far"');
  ok('append: exactly one write, spliced', t.writes.length === 1 && t.writes[0].includes('- [New #3](https://x/3): added.'));
  ok('append: edit passes the issue and repo', t.calls.some((c) => c.startsWith('issue edit 7 ') && c.includes('-R o/r')));
  ok('append: temp body file removed', t.tmpSeen.length === 1 && !fs.existsSync(t.tmpSeen[0]));
}

// --- read retry and fail-safe reads ------------------------------------------
{
  const t = makeTracker({ viewFail: 1 });
  const r = runMain(APPEND, t);
  ok('read: one failed read is retried', r.code === 0 && t.writes.length === 1);
}
for (const [name, init] of [
  ['non-zero exit twice', { viewFail: 5 }],
  ['empty body', { body: '' }],
  ['whitespace body', { body: '   \n\n  ' }],
  ['degenerate body', { body: 'x\n## Decisions so far' }],
]) {
  const t = makeTracker(init);
  const r = runMain(APPEND, t);
  ok(`abort: ${name}: exit 1`, r.code === 1);
  ok(`abort: ${name}: aborted line`, /^aborted: /.test(r.out.trim()) && r.out.trim().split('\n').length === 1);
  ok(`abort: ${name}: nothing written`, t.writes.length === 0 && !t.calls.some((c) => c.startsWith('issue edit')));
}
{
  const t = makeTracker();
  t.viewRaw = 'not json';
  const r = runMain(APPEND, t);
  ok('abort: unparseable JSON, nothing written', r.code === 1 && t.writes.length === 0 && /^aborted: /.test(r.out));
  const t2 = makeTracker();
  t2.viewRaw = JSON.stringify({ updatedAt: 'T1' });
  const r2 = runMain(APPEND, t2);
  ok('abort: JSON without a body, nothing written', r2.code === 1 && t2.writes.length === 0);
}
{
  const t = makeTracker();
  const r = runMain(['append', '--issue', '7', '--section', 'Missing', '--line', '- x'], t);
  ok('abort: missing section, nothing written', r.code === 1 && /Missing/.test(r.out) && t.writes.length === 0);
}
{
  const t = makeTracker();
  const r = runMain(['replace', '--issue', '7', '--section', 'Destination', '--file', writeTmp('')], t);
  ok('replace with empty text keeps a non-empty body and writes', r.code === 0 && t.writes.length === 1);
  const t2 = makeTracker({ body: 'Intro line long enough for the check.' });
  const r2 = runMain(['replace', '--issue', '7', '--section', ':preamble', '--file', writeTmp('   \n')], t2);
  ok('abort: a result that would be an empty body is refused', r2.code === 1 && t2.writes.length === 0 && /empty/.test(r2.out));
}

function writeTmp(text) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'issue-body-test-')), 'in.md');
  fs.writeFileSync(p, text);
  return p;
}

// --- optimistic concurrency --------------------------------------------------
{
  // The first re-read before the write shows a moved updatedAt (n=2 is the
  // pre-write check): the op is re-applied on the fresh body, then written.
  const t = makeTracker({
    onView: (tr, n) => { if (n === 2) tr.externalEdit(MAP + '\n## Extra\n- concurrent addition\n'); },
  });
  const r = runMain(APPEND, t);
  ok('moved once: re-applied and written', r.code === 0 && t.writes.length === 1);
  ok('moved once: the concurrent addition survives', t.writes[0].includes('concurrent addition') && t.writes[0].includes('- [New #3]'));
}
{
  const t = makeTracker({
    onView: (tr, n) => { if (n === 2 || n === 3) tr.externalEdit(tr.body + '\nmore ' + n); },
  });
  const r = runMain(APPEND, t);
  ok('moved twice: abort, nothing written', r.code === 1 && t.writes.length === 0 && /changed/.test(r.out));
}

// --- post-write conflict check -----------------------------------------------
{
  // An external edit lands between the last check and our write: the final body
  // is ours (we overwrote it), the edit count moved by one more than our write.
  const t = makeTracker({ beforeEdit: (tr) => tr.externalEdit('someone else wrote this body, long enough') });
  const r = runMain(APPEND, t);
  ok('conflict: exit 1', r.code === 1);
  ok('conflict: message names the recovery', /^aborted: conflict: a concurrent edit landed during the write, the overwritten text is in the issue's edit history/.test(r.out.trim()) && /edited/.test(r.out));
  ok('conflict: never silent (our body was written)', t.writes.length === 1);
}
{
  const t = makeTracker({ garbleReadback: true });
  const r = runMain(APPEND, t);
  ok('conflict: a read-back mismatch is a conflict', r.code === 1 && /conflict/.test(r.out));
}
{
  const t = makeTracker({ writeDelta: 2, edits: 0 });
  const r = runMain(APPEND, t);
  ok('first edit, delta 2: accepted by default (confirmed live)', r.code === 0 && !/conflict/.test(r.out));
  const t2 = makeTracker({ writeDelta: 2, edits: 0 });
  const g = guardedWrite(7, (b) => b + '\n- z', { gh: t2.gh, guard: fakeGuard, repo: 'o/r', firstEditDelta2: true });
  ok('first edit, delta 2: accepted with the explicit opt', g.ok === true);
  const t3 = makeTracker({ writeDelta: 2, edits: 5 });
  const g3 = guardedWrite(7, (b) => b + '\n- z', { gh: t3.gh, guard: fakeGuard, repo: 'o/r', firstEditDelta2: true });
  ok('delta 2 on an already-edited issue stays a conflict', g3.ok === false && g3.conflict === true);
}
{
  const t = makeTracker({ countFails: true });
  const r = runMain(APPEND, t);
  ok('abort: the baseline cannot be read, nothing written', r.code === 1 && t.writes.length === 0);
}
{
  const t = makeTracker({ editFails: true });
  const r = runMain(APPEND, t);
  ok('abort: gh issue edit failing is reported, temp removed', r.code === 1 && /aborted: /.test(r.out) && !fs.existsSync(t.tmpSeen[0]));
}

// --- W1: the baseline is read BEFORE the last updatedAt check ----------------
{
  const t = makeTracker();
  runMain(APPEND, t);
  const countIdx = t.calls.findIndex((c) => c.startsWith('api graphql'));
  const editIdx = t.calls.findIndex((c) => c.startsWith('issue edit'));
  const viewsBeforeEdit = t.calls.map((c, i) => (c.startsWith('issue view') && i < editIdx ? i : -1)).filter((i) => i >= 0);
  ok('W1: the edit-count baseline precedes the final updatedAt re-read', countIdx >= 0 && countIdx < viewsBeforeEdit[viewsBeforeEdit.length - 1]);
}
{
  // An edit landing at the baseline read must not be absorbed into the baseline.
  const hit = (tr, n) => { if (n === 1) tr.externalEdit(MAP + '\n## Extra\n- landed at the baseline\n'); };
  const t = makeTracker({ onCount: hit });
  const g = guardedWrite(7, 'A whole new generated body, long enough.\n', { gh: t.gh, guard: fakeGuard, repo: 'o/r' });
  ok('W1: an edit at the baseline read aborts a whole-body write, never clean', g.ok === false && t.writes.length === 0);
  const t2 = makeTracker({ onCount: hit });
  const r2 = runMain(APPEND, t2);
  ok('W1: a splice re-applies on the fresh body, keeping the concurrent edit', r2.code === 0 && t2.writes.length === 1 && t2.writes[0].includes('landed at the baseline'));
  ok('W1: the repo slug is resolved once per write', (() => {
    const t3 = makeTracker();
    guardedWrite(7, (b) => b + '\n- z', { gh: t3.gh, guard: fakeGuard });
    return t3.calls.filter((c) => c.startsWith('repo view')).length === 1;
  })());
}

// --- secret scan -------------------------------------------------------------
{
  const t = makeTracker();
  const r = runMain(['append', '--issue', '7', '--section', 'Decisions so far', '--line', '- token ghp_' + 'a'.repeat(36)], t);
  ok('secret hit: abort, nothing written', r.code === 1 && /secret/.test(r.out) && t.writes.length === 0);
  ok('secret hit: the secret is not echoed', !r.out.includes('ghp_'));
}
{
  const t = makeTracker();
  const r = runMain(APPEND, t, { guard: null });
  ok('fail closed: no guard module, abort with the fallback hint', r.code === 1 && r.out.trim() === 'aborted: secret-scan unavailable, use the prose fallback' && t.writes.length === 0);
  const boom = runMain(APPEND, makeTracker(), { guard: { scan: () => { throw new Error('fault'); } } });
  ok('fail closed: a scan fault aborts', boom.code === 1 && /secret-scan/.test(boom.out));
}
{
  const g = loadGuard();
  ok('loadGuard: finds the shipped guard from the source layout', g && typeof g.scan === 'function');
  ok('loadGuard: the real guard flags a token', typeof g.scan('see ghp_' + 'b'.repeat(36), {}) === 'string');
  ok('loadGuard: the real guard passes plain prose', g.scan('- [A thing #1](https://x/1): did it.', {}) === null);
  const stray = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-body-noguard-'));
  ok('loadGuard: null when no module is found', loadGuard([path.join(stray, 'a.js'), path.join(stray, 'b.js')]) === null);
}

// --- remove / replace via main -----------------------------------------------
{
  const t = makeTracker();
  const r = runMain(['remove', '--issue', '7', '--section', 'Decisions so far', '--match', 'Other #2'], t);
  ok('remove via main: summary and write', r.code === 0 && r.out.trim() === 'issue #7: removed 1 entry from "Decisions so far"' && t.writes.length === 1);
  const t2 = makeTracker();
  const r2 = runMain(['remove', '--issue', '7', '--section', 'Decisions so far', '--match', 'zzz'], t2);
  ok('remove no-op: exit 0, reported, nothing written', r2.code === 0 && /no entry/.test(r2.out) && t2.writes.length === 0);
  const t3 = makeTracker();
  const r3 = runMain(['remove', '--issue', '7', '--section', 'Decisions so far', '--match', '#'], t3);
  ok('remove ambiguous: exit 1, nothing written', r3.code === 1 && /ambiguous/.test(r3.out) && t3.writes.length === 0);
  const t4 = makeTracker();
  const r4 = runMain(['replace', '--issue', '7', '--section', 'Not yet specified', '--file', writeTmp('- only this\n')], t4);
  ok('replace via main: summary and write', r4.code === 0 && /replaced "Not yet specified"/.test(r4.out) && t4.writes[0].includes('- only this'));
}

// --- dry run -----------------------------------------------------------------
{
  const t = makeTracker();
  const r = runMain([...APPEND, '--dry-run'], t);
  ok('dry-run: exit 0, nothing written, no edit call', r.code === 0 && t.writes.length === 0 && !t.calls.some((c) => c.startsWith('issue edit')));
  ok('dry-run: one line with old and new byte sizes', r.out.trim().split('\n').length === 1 && /dry-run/.test(r.out) && new RegExp(`${Buffer.byteLength(MAP)} -> ${Buffer.byteLength(MAP) + Buffer.byteLength('- [New #3](https://x/3): added.\n')}`).test(r.out));
  const s = runMain([...APPEND.slice(0, 7), '--line', '- ghp_' + 'c'.repeat(36), '--dry-run'], makeTracker());
  ok('dry-run: still runs the secret scan', s.code === 1);
}

// --- usage errors ------------------------------------------------------------
for (const argv of [
  [],
  ['frobnicate', '--issue', '1'],
  ['append', '--section', 'x', '--line', 'y'],
  ['append', '--issue', 'abc', '--section', 'x', '--line', 'y'],
  ['append', '--issue', '1', '--line', 'y'],
  ['append', '--issue', '1', '--section', 'x'],
  ['append', '--issue', '1', '--section', 'x', '--line', 'y', '--file', 'f'],
  ['replace', '--issue', '1', '--section', 'x'],
  ['remove', '--issue', '1', '--section', 'x'],
  ['remove', '--issue', '1', '--section', 'x', '--match', ''],
  ['append', '--issue', '1', '--section', 'x', '--line', 'y', '--bogus', 'z'],
  ['append', '--issue', '1', '--section', 'x', '--line'],
  ['replace', '--issue', '1', '--section', 'x', '--file', '/nonexistent/file.md'],
]) {
  const t = makeTracker();
  const r = runMain(argv, t);
  ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2 && r.err.length > 0 && r.out === '' && t.calls.length === 0);
}

// --- guardedWrite: whole-body ------------------------------------------------
{
  const t = makeTracker();
  const body = 'A whole new generated body, long enough.\n';
  const g = guardedWrite(7, body, { gh: t.gh, guard: fakeGuard, repo: 'o/r' });
  ok('guardedWrite: whole-body string writes', g.ok === true && t.writes[0] === body && g.oldSize === Buffer.byteLength(MAP) && g.newSize === Buffer.byteLength(body));
  const t2 = makeTracker({ onView: (tr, n) => { if (n === 2) tr.externalEdit(tr.body + '\nx'); } });
  const g2 = guardedWrite(7, body, { gh: t2.gh, guard: fakeGuard, repo: 'o/r' });
  ok('guardedWrite: a string cannot be re-applied, a moved updatedAt aborts', g2.ok === false && t2.writes.length === 0);
  const t3 = makeTracker();
  const g3 = guardedWrite(7, '  \n', { gh: t3.gh, guard: fakeGuard, repo: 'o/r' });
  ok('guardedWrite: empty body refused', g3.ok === false && t3.writes.length === 0);
  const t4 = makeTracker();
  const g4 = guardedWrite(7, 'harmless body that is long enough', { gh: t4.gh, guard: fakeGuard, repo: 'o/r', scanText: 'ghp_' + 'd'.repeat(36) });
  ok('guardedWrite: scanText overrides what is scanned', g4.ok === false && /secret/.test(g4.reason) && t4.writes.length === 0);
}
{
  const t = makeTracker();
  // repo resolved through `gh repo view` when not passed
  guardedWrite(7, 'A whole new generated body, long enough.\n', { gh: t.gh, guard: fakeGuard });
  ok('guardedWrite: repo resolved from gh when absent', t.calls.some((c) => c.startsWith('repo view')));
}

// --- end-to-end with a fake gh on PATH ---------------------------------------
{
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-body-bin-'));
  const log = path.join(binDir, 'calls.log');
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  const res = spawnSync('node', [scriptPath, ...APPEND], { encoding: 'utf8', env: { ...process.env, PATH: binDir + path.delimiter + process.env.PATH } });
  ok('e2e: gh failing aborts with exit 1 and one line', res.status === 1 && /^aborted: /.test(res.stdout) && res.stdout.trim().split('\n').length === 1);
  ok('e2e: gh was called with the view', /issue view 7/.test(fs.readFileSync(log, 'utf8')));
  const bad = spawnSync('node', [scriptPath, 'append'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', bad.status === 2);
}

console.log(`issue-body.test.js: ${passed} checks passed`);
