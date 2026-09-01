#!/usr/bin/env node
// Tests for trailhead-commit-guard.js. Run: node trailhead-commit-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const HOOK = path.join(__dirname, 'trailhead-commit-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Run the hook end-to-end: pipe tool_input JSON on stdin, capture {code, out}.
function runHook(command) {
  const input = JSON.stringify({ tool_input: { command } });
  try {
    const out = execFileSync('node', [HOOK], { input });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
  }
}

// --- regression #121: a command-substitution / heredoc -m carrying a VALID
// conventional message must be ALLOWED, not blocked on the literal heredoc
// syntax the guard cannot statically expand.
const heredocCmd = [
  'git commit -m "$(cat <<\'EOF\'',
  'feat: something valid',
  'EOF',
  ')"',
].join('\n');
const r1 = runHook(heredocCmd);
ok('command-substitution/heredoc -m with a valid message is allowed (exit 0)', r1.code === 0 && r1.out.trim() === '');

// --- a backtick-containing -m value is allowed (fail open) ---
const r2 = runHook('git commit -m "`echo feat: something valid`"');
ok('backtick -m value is allowed (exit 0)', r2.code === 0 && r2.out.trim() === '');

// --- a plain quoted VALID -m is still allowed ---
const r3 = runHook('git commit -m "feat: something valid"');
ok('plain quoted valid -m is allowed (exit 0)', r3.code === 0 && r3.out.trim() === '');

// --- a plain quoted INVALID -m is still BLOCKED ---
const r4 = runHook('git commit -m "not a conventional subject"');
ok('plain quoted invalid -m is blocked (exit 2)', r4.code === 2 && /CONVENTIONAL_COMMITS_VIOLATION/.test(r4.out));

// --- a Co-Authored-By trailer anywhere is still BLOCKED ---
const r5 = runHook('git commit -m "feat: ok\n\nCo-Authored-By: Someone <a@b.c>"');
ok('Co-Authored-By trailer is blocked (exit 2)', r5.code === 2 && /CO_AUTHORED_BY_FORBIDDEN/.test(r5.out));

// --- a non-git-commit command is allowed ---
const r6 = runHook('ls -la');
ok('non-git-commit command is allowed (exit 0)', r6.code === 0 && r6.out.trim() === '');

// --- code review follow-up (#121): single-quoted values are shell-literal,
// so `$(` / backtick text inside single quotes is NOT expanded and must be
// validated like any other message. A single-quoted bad message containing
// `$(` must still be BLOCKED.
const r7 = runHook("git commit -m '$(not a conventional subject)'");
ok('single-quoted bad -m with $( is blocked (exit 2)', r7.code === 2 && /CONVENTIONAL_COMMITS_VIOLATION/.test(r7.out));

// --- single-quoted bad message containing a backtick must still be BLOCKED ---
const r8 = runHook("git commit -m 'has a ` backtick and is not conventional'");
ok('single-quoted bad -m with a backtick is blocked (exit 2)', r8.code === 2 && /CONVENTIONAL_COMMITS_VIOLATION/.test(r8.out));

// --- the `<<` sub-pattern was redundant and caused false negatives on
// ordinary text like "a<<b"; it must be removed so this is BLOCKED ---
const r9 = runHook('git commit -m "a<<b is not a conventional subject"');
ok('double-quoted bad -m containing a<<b is blocked (exit 2)', r9.code === 2 && /CONVENTIONAL_COMMITS_VIOLATION/.test(r9.out));

// --- regression guard: a single-quoted VALID conventional message is
// still allowed ---
const r10 = runHook("git commit -m 'feat: valid subject'");
ok('single-quoted valid -m is allowed (exit 0)', r10.code === 0 && r10.out.trim() === '');

console.log(`✓ commit-guard: ${passed} assertions passed`);
