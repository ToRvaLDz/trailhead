#!/usr/bin/env node
// Tests for trailhead-search-guard.js. Run: node trailhead-search-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const HOOK = path.join(__dirname, 'trailhead-search-guard.js');

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

// --- ticket #134: the exact regression command must be BLOCKED ---
const ticketCmd = String.raw`cd app && grep -n "go_router" pubspec.yaml pubspec.lock | head; echo "=== router file ==="; grep -rln "GoRouter(" lib/ ; echo "=== /who route def ==="; grep -rn "'/who'\|\"/who\"\|/profile/manage\|path: '/home'" lib/ | head -30`;
const rTicket = runHook(ticketCmd);
ok('ticket #134 exact command is blocked (exit 2)', rTicket.code === 2 && /SEARCH_HYGIENE_VIOLATION|search-hygiene/.test(rTicket.out));

// --- BLOCK cases ---
const r1 = runHook('cd app && grep -n "go_router" pubspec.yaml');
ok('cd <relative> && grep <relative> is blocked (exit 2)', r1.code === 2 && /search-hygiene/.test(r1.out));

const r2 = runHook('cd /abs/app; grep -rln "GoRouter(" lib/');
ok('cd <abs>; grep <relative> is blocked (exit 2)', r2.code === 2 && /search-hygiene/.test(r2.out));

const r3 = runHook('pushd app && cat file.txt');
ok('pushd <dir> && cat <relative> is blocked (exit 2)', r3.code === 2 && /search-hygiene/.test(r3.out));

const r4 = runHook('cd app && wc -l foo.txt');
ok('cd <dir> && wc -l <relative> is blocked (exit 2)', r4.code === 2 && /search-hygiene/.test(r4.out));

const r5 = runHook('cd app &&\ngrep -n "x" foo.txt\n');
ok('cd <dir> && then relative grep on a later line (newline-joined) is blocked (exit 2)', r5.code === 2 && /search-hygiene/.test(r5.out));

const r6 = runHook('cd app; echo hi; grep -n "x" foo.txt');
ok('cd <dir>; ...; relative grep several statements later is blocked (exit 2)', r6.code === 2 && /search-hygiene/.test(r6.out));

const r7 = runHook('env -C app grep -n "x" foo.txt');
ok('env -C <dir> grep <relative> (single statement) is blocked (exit 2)', r7.code === 2 && /search-hygiene/.test(r7.out));

const r8 = runHook('cd app && git log -- foo.txt');
ok('cd <dir> && git log without -C on a relative path is blocked (exit 2)', r8.code === 2 && /search-hygiene/.test(r8.out));

const r9 = runHook('cd app && rg "TODO" foo.txt');
ok('cd <dir> && rg <relative> is blocked (exit 2)', r9.code === 2 && /search-hygiene/.test(r9.out));

// --- ALLOW cases (no false positives) ---
const a1 = runHook('grep -n "x" /abs/app/pubspec.yaml');
ok('path-explicit grep with no cd is allowed (exit 0)', a1.code === 0 && a1.out.trim() === '');

const a2 = runHook('git -C /abs/app grep "x"');
ok('git -C <abs> grep is allowed (exit 0)', a2.code === 0 && a2.out.trim() === '');

const a3 = runHook('cd /abs && npm test');
ok('cd <abs> && npm test (no read/search verb) is allowed (exit 0)', a3.code === 0 && a3.out.trim() === '');

const a4 = runHook('cd /abs && ls -la');
ok('cd <abs> && ls (not a Read()-denied verb) is allowed (exit 0)', a4.code === 0 && a4.out.trim() === '');

const a5 = runHook('cd /abs/app');
ok('a bare standalone cd <abs> alone is allowed (exit 0) - known limitation, never block a lone cd', a5.code === 0 && a5.out.trim() === '');

const a6 = runHook('grep "cd foo" /abs/file');
ok('grep whose pattern happens to contain "cd" but path is absolute is allowed (exit 0)', a6.code === 0 && a6.out.trim() === '');

const a7 = runHook('grep -n "x" file --with-something');
ok('command with no cd at all is allowed regardless of relative path (exit 0)', a7.code === 0 && a7.out.trim() === '');

const a8 = runHook('cd /abs/app && grep -n "x" /abs/app/foo.txt');
ok('cd <abs> && grep with an absolute-path argument is allowed (exit 0)', a8.code === 0 && a8.out.trim() === '');

const a9 = runHook('cd /abs/app && grep -n "x" -r --include=*.js');
ok('cd <abs> && grep with only flags/patterns (no file arg) is allowed (exit 0)', a9.code === 0 && a9.out.trim() === '');

// --- #134 follow-up: Finding 1 - heredoc bodies are DATA, not statements ---
const h1 = runHook(`cat > setup.sh <<'EOF'\ncd /some/dir\ngrep -n pattern file.txt\nEOF\n`);
ok('heredoc body (cd + grep as literal data) is allowed, not parsed as statements (exit 0)', h1.code === 0 && h1.out.trim() === '');

const h2 = runHook(`bash -c 'cat' <<EOF\ncd app\ngrep -n x foo.txt\nEOF\n`);
ok('heredoc fed to a command is allowed, its body is data not executed statements (exit 0)', h2.code === 0 && h2.out.trim() === '');

const h3 = runHook(`cat > setup.sh <<'EOF'\nsome literal data\nEOF\ncd app && grep -n x foo.txt`);
ok('a REAL cd + grep violation outside a heredoc on the same command still blocks (exit 2)', h3.code === 2 && /search-hygiene/.test(h3.out));

// --- #134 follow-up: Finding 2 - grouping containers must not hide the violation ---
const g1 = runHook('(cd app && grep -n x foo.txt)');
ok('subshell-wrapped cd + grep is blocked (exit 2)', g1.code === 2 && /search-hygiene/.test(g1.out));

const g2 = runHook('{ cd app; grep -n x foo.txt; }');
ok('brace-group-wrapped cd + grep is blocked (exit 2)', g2.code === 2 && /search-hygiene/.test(g2.out));

const g3 = runHook('for d in */; do cd "$d" && grep -n x foo.txt; cd ..; done');
ok('loop-body cd + grep is blocked (exit 2)', g3.code === 2 && /search-hygiene/.test(g3.out));

const g4 = runHook('(cd /abs && npm test)');
ok('subshell-wrapped cd <abs> && npm test (no read verb) is still allowed (exit 0)', g4.code === 0 && g4.out.trim() === '');

console.log(`✓ search-guard: ${passed} assertions passed`);
