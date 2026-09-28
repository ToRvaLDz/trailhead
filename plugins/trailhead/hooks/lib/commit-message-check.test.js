#!/usr/bin/env node
// Tests for commit-message-check.js. Run: node commit-message-check.test.js
// No framework: plain asserts, mirrors the style of trailhead-secret-guard.test.js.
//
// Drives the SAME fixtures through two paths:
//   1. checkCommitMessage() directly (the source of truth).
//   2. the template hook (templates/trailhead-commit-msg) end-to-end via
//      execFileSync, feeding it the message as a temp file, run from a fresh
//      mkdtemp cwd (so the template's own .trailhead/session-ticket lookup is
//      independent of this repo's real marker).
// The two verdicts must always agree: that agreement is the anti-drift
// guarantee that keeps the Claude Code hook and the git commit-msg hook from
// ever diverging.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { checkCommitMessage, parseSessionTicket, hasRefsFor } = require('./commit-message-check.js');

const templatePath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-commit-msg');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const FIXTURES = [
  { name: 'valid subject', message: 'feat: add thing', expectOk: true },
  { name: 'valid with scope and body', message: 'fix(installer): x\n\nbody line', expectOk: true },
  { name: 'non-conventional subject', message: 'add thing', expectOk: false, code: 'CONVENTIONAL_COMMITS_VIOLATION' },
  { name: 'subject too long', message: 'feat: ' + 'x'.repeat(70), expectOk: false, code: 'COMMIT_SUBJECT_TOO_LONG' },
  { name: 'co-authored anywhere', message: 'feat: x\n\nCo-authored-by: A <a@b.c>', expectOk: false, code: 'CO_AUTHORED_BY_FORBIDDEN' },
  { name: 'leading git comment lines then valid subject', message: '# comment\n\nfeat: x', expectOk: true },
  {
    name: 'verbose scissors: co-authored past the scissors is ignored',
    message: 'feat: x\n\n# ------------------------ >8 ------------------------\ndiff with Co-authored-by: junk',
    expectOk: true,
  },
  { name: 'empty message', message: '', expectOk: true },
];

// --- unit: checkCommitMessage() directly (no ticket, no marker) ---
for (const f of FIXTURES) {
  const verdict = checkCommitMessage(f.message);
  ok(`checkCommitMessage: ${f.name} -> ok=${f.expectOk}`, verdict.ok === f.expectOk);
  if (!f.expectOk && f.code) {
    ok(`checkCommitMessage: ${f.name} -> code=${f.code}`, verdict.code === f.code);
  }
}

// --- end-to-end: drive the template hook on the SAME fixtures, no marker ---
function runTemplateHook(message, marker) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-commit-msg-test-'));
  const tmpFile = path.join(tmp, 'COMMIT_EDITMSG');
  fs.writeFileSync(tmpFile, message);
  if (marker !== undefined) {
    fs.mkdirSync(path.join(tmp, '.trailhead'));
    fs.writeFileSync(path.join(tmp, '.trailhead', 'session-ticket'), marker);
  }
  let allowed = true;
  let stderr = '';
  try {
    execFileSync('node', [templatePath, tmpFile], { cwd: tmp, stdio: 'pipe' });
  } catch (e) {
    allowed = false;
    stderr = e.stderr ? e.stderr.toString() : '';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { allowed, stderr };
}

for (const f of FIXTURES) {
  const { allowed } = runTemplateHook(f.message);
  const expected = checkCommitMessage(f.message).ok;
  ok(`template hook: ${f.name} -> allowed=${expected}`, allowed === expected);
}

// --- stripComments seam: the `-m` guard path (stripComments:false) must NOT
// treat a `#`-leading subject as a comment (git -m keeps `#` lines as text),
// while the default file-semantics path (strip=true) does. Regression guard for
// the parity gap the code review caught. ---
const hashSubject = '#123 wip do stuff';
ok('no-strip: #-leading subject is a real (non-conventional) subject -> block',
  checkCommitMessage(hashSubject, { stripComments: false }).ok === false);
ok('no-strip: #-leading subject blocks with the conventional code',
  checkCommitMessage(hashSubject, { stripComments: false }).code === 'CONVENTIONAL_COMMITS_VIOLATION');
ok('default strip: #-leading line is a comment -> empty subject -> allow',
  checkCommitMessage(hashSubject).ok === true);
ok('template hook: #-leading message is file-semantics (comment) -> allow',
  runTemplateHook(hashSubject).allowed === true);

// --- parseSessionTicket unit cases ---
ok('parseSessionTicket: normal marker', parseSessionTicket('#184 Enforce the Refs trailer\n') === 184);
ok('parseSessionTicket: number only', parseSessionTicket('#184') === 184);
ok('parseSessionTicket: empty text', parseSessionTicket('') === null);
ok('parseSessionTicket: missing hash', parseSessionTicket('184 Title') === null);
ok('parseSessionTicket: non-numeric', parseSessionTicket('#abc') === null);
ok('parseSessionTicket: zero', parseSessionTicket('#0 Title') === null);
ok('parseSessionTicket: trailing junk glued to number', parseSessionTicket('#184x Title') === null);
ok('parseSessionTicket: BOM stripped', parseSessionTicket('﻿#184 Title') === 184);
ok('parseSessionTicket: CRLF stripped', parseSessionTicket('#184 Title\r\nsecond line') === 184);

// --- Refs / ticket fixtures: [marker, message, expectOk, expectCode?] ---
const REFS_FIXTURES = [
  { name: 'refs matches marker', marker: '#184 Title\n', message: 'feat: x\n\nRefs: #184', expectOk: true },
  { name: 'refs multi list matches', marker: '#184 Title\n', message: 'feat: x\n\nRefs: #12, #184', expectOk: true },
  { name: 'lowercase refs matches', marker: '#184 Title\n', message: 'feat: x\n\nrefs: #184', expectOk: true },
  { name: 'no refs at all', marker: '#184 Title\n', message: 'feat: x', expectOk: false, code: 'REFS_TRAILER_MISSING' },
  { name: 'refs wrong ticket', marker: '#184 Title\n', message: 'feat: x\n\nRefs: #183', expectOk: false, code: 'REFS_TRAILER_MISSING' },
  { name: 'refs prefix-only mismatch (18 vs 184)', marker: '#184 Title\n', message: 'feat: x\n\nRefs: #18', expectOk: false, code: 'REFS_TRAILER_MISSING' },
  { name: 'marker itself truncated (#18) with refs #184', marker: '#18 Title\n', message: 'feat: x\n\nRefs: #184', expectOk: false, code: 'REFS_TRAILER_MISSING' },
  { name: 'refs suffix junk rejected (#184abc)', marker: '#184 Title\n', message: 'feat: x\n\nRefs: #184abc', expectOk: false, code: 'REFS_TRAILER_MISSING' },
  { name: 'refs only inside a comment line', marker: '#184 Title\n', message: 'feat: x\n\n# Refs: #184', expectOk: false, code: 'REFS_TRAILER_MISSING' },
  {
    name: 'refs only after the scissors line',
    marker: '#184 Title\n',
    message: 'feat: x\n\n# ------------------------ >8 ------------------------\nRefs: #184',
    expectOk: false,
    code: 'REFS_TRAILER_MISSING',
  },
  { name: 'empty message with active marker still requires refs', marker: '#184 Title\n', message: '', expectOk: false, code: 'REFS_TRAILER_MISSING' },
  { name: 'no marker: refs rule off, plain conventional commit ok', marker: undefined, message: 'feat: x', expectOk: true },
  { name: 'malformed marker (no hash): rule off', marker: '184 Title\n', message: 'feat: x', expectOk: true },
  { name: 'malformed marker (non-numeric): rule off', marker: '#abc\n', message: 'feat: x', expectOk: true },
  { name: 'malformed marker (empty file): rule off', marker: '', message: 'feat: x', expectOk: true },
  { name: 'malformed marker (#0): rule off', marker: '#0 Title\n', message: 'feat: x', expectOk: true },
  {
    name: 'precedence: non-conventional subject without refs -> conventional code wins',
    marker: '#184 Title\n',
    message: 'wip stuff',
    expectOk: false,
    code: 'CONVENTIONAL_COMMITS_VIOLATION',
  },
];

for (const f of REFS_FIXTURES) {
  const ticket = parseSessionTicket(f.marker === undefined ? '' : f.marker);
  const verdict = checkCommitMessage(f.message, { ticket });
  ok(`checkCommitMessage(ticket): ${f.name} -> ok=${f.expectOk}`, verdict.ok === f.expectOk);
  if (!f.expectOk && f.code) {
    ok(`checkCommitMessage(ticket): ${f.name} -> code=${f.code}`, verdict.code === f.code);
  }

  const { allowed, stderr } = runTemplateHook(f.message, f.marker);
  ok(`template hook(ticket): ${f.name} -> allowed=${f.expectOk}`, allowed === f.expectOk);
  if (!f.expectOk && f.code === 'REFS_TRAILER_MISSING') {
    ok(`template hook(ticket): ${f.name} -> stderr matches lib reason`,
      stderr.trim() === verdict.reason);
  }
}

// --- extra API asserts from the plan ---
ok('checkCommitMessage: string ticket disables the rule (never blocks)',
  checkCommitMessage('feat: x', { ticket: '184' }).ok === true);
ok('checkCommitMessage: numeric ticket + stripComments:false still finds Refs',
  checkCommitMessage('feat: x\n\nRefs: #184', { ticket: 184, stripComments: false }).ok === true);

// --- template stderr content check for the missing-refs case ---
{
  const { stderr } = runTemplateHook('feat: x', '#184 Title\n');
  ok('template stderr mentions Refs: #184', stderr.includes('Refs: #184'));
}

// --- hasRefsFor unit checks ---
ok('hasRefsFor: direct match', hasRefsFor('Refs: #184', 184) === true);
ok('hasRefsFor: no match', hasRefsFor('Refs: #18', 184) === false);
ok('hasRefsFor: a "# Refs:" comment line never counts',
  hasRefsFor('# Refs: #184', 184) === false);
ok('hasRefsFor: a Refs line in a multi-line body counts',
  hasRefsFor('feat: x\n\nbody\n\nRefs: #184', 184) === true);

console.log(`✓ commit-message-check: ${passed} assertions passed`);
