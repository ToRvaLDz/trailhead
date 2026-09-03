#!/usr/bin/env node
// Tests for trailhead-secret-read-guard.js. Run: node trailhead-secret-read-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { detectSecretRead } = require('./trailhead-secret-read-guard.js');

const HOOK = path.join(__dirname, 'trailhead-secret-read-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Run the hook end-to-end: pipe {tool_name, tool_input} JSON on stdin, capture {code, out}.
function runHook(toolName, toolInput) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  try {
    const out = execFileSync('node', [HOOK], { input });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
  }
}

// --- pure seam: detectSecretRead ---

// --- DENY cases ---
ok('Read .env is denied', !!detectSecretRead('Read', { file_path: '.env' }));
ok('Read config/.env.local is denied', !!detectSecretRead('Read', { file_path: 'config/.env.local' }));
ok('Read .secrets is denied', !!detectSecretRead('Read', { file_path: '.secrets' }));
ok('Bash cat .env is denied', !!detectSecretRead('Bash', { command: 'cat .env' }));
ok('Bash cat < .secrets is denied', !!detectSecretRead('Bash', { command: 'cat < .secrets' }));
ok('Bash grep -n KEY .env.production is denied', !!detectSecretRead('Bash', { command: 'grep -n KEY .env.production' }));
ok('Bash cat app/.env.local is denied', !!detectSecretRead('Bash', { command: 'cat app/.env.local' }));
ok('Bash cat --file=.env is denied', !!detectSecretRead('Bash', { command: 'cat --file=.env' }));

// --- ALLOW cases (no false positives) ---
ok('Read src/app.ts is allowed', !detectSecretRead('Read', { file_path: 'src/app.ts' }));
ok('Bash grep -n x pubspec.yaml is allowed', !detectSecretRead('Bash', { command: 'grep -n x pubspec.yaml' }));
ok('Bash cat README.md is allowed', !detectSecretRead('Bash', { command: 'cat README.md' }));
ok('Bash cd app && grep x pubspec.yaml is allowed (not a secret; search-guard governs the cd shape)',
  !detectSecretRead('Bash', { command: 'cd app && grep x pubspec.yaml' }));
ok('Read env.sample (near-miss) is allowed', !detectSecretRead('Read', { file_path: 'env.sample' }));
ok('Read .environment (near-miss) is allowed', !detectSecretRead('Read', { file_path: '.environment' }));

// --- #135 follow-up: Finding 1 - glued shell metacharacters must not bypass detection ---
ok('Bash cat .env|grep KEY is denied (glued pipe)', !!detectSecretRead('Bash', { command: 'cat .env|grep KEY' }));
ok('Bash cat .env;echo done is denied (glued semicolon)', !!detectSecretRead('Bash', { command: 'cat .env;echo done' }));
ok('Bash cat .env&&echo done is denied (glued &&)', !!detectSecretRead('Bash', { command: 'cat .env&&echo done' }));
ok('Bash bash -c "cat .env" is denied (quoted sub-command)', !!detectSecretRead('Bash', { command: 'bash -c "cat .env"' }));
ok('Bash eval "cat .env" is denied (quoted sub-command)', !!detectSecretRead('Bash', { command: 'eval "cat .env"' }));

// --- #135 follow-up: Finding 2 - glued short-option value must not bypass detection ---
ok('Bash cat -f.env is denied (glued short-flag value)', !!detectSecretRead('Bash', { command: 'cat -f.env' }));

// --- #135 follow-up: Finding 3 - bare .env inside quoted prose must not false-positive ---
ok('Bash git commit -m "document .env usage" is allowed (quoted prose, not a file operand)',
  !detectSecretRead('Bash', { command: 'git commit -m "document .env usage"' }));
ok('Bash echo "See .env for config" >> README.md is allowed (quoted prose)',
  !detectSecretRead('Bash', { command: 'echo "See .env for config" >> README.md' }));
ok('Bash cat ".env" is still denied (a quoted LONE path is still a secret path)',
  !!detectSecretRead('Bash', { command: 'cat ".env"' }));

// --- #135 follow-up: Finding 4 - quoted grep pattern must not false-positive ---
ok('Bash grep ".env" config.txt is allowed (the read target is config.txt, not the pattern)',
  !detectSecretRead('Bash', { command: 'grep ".env" config.txt' }));
ok("Bash grep '.env' config.txt is allowed (single-quoted pattern)",
  !detectSecretRead('Bash', { command: "grep '.env' config.txt" }));
ok('Bash grep -n KEY .env.production is still denied (secret is the FILE operand, not the pattern)',
  !!detectSecretRead('Bash', { command: 'grep -n KEY .env.production' }));

// --- #135 follow-up: Finding 5 - case-insensitivity (same file on macOS/Windows) ---
ok('Read .ENV is denied (case-insensitive)', !!detectSecretRead('Read', { file_path: '.ENV' }));
ok('Bash cat .SECRETS is denied (case-insensitive)', !!detectSecretRead('Bash', { command: 'cat .SECRETS' }));
ok('Read ENV.SAMPLE (near-miss) is still allowed regardless of case', !detectSecretRead('Read', { file_path: 'ENV.SAMPLE' }));
ok('Read .ENVIRONMENT (near-miss) is still allowed regardless of case', !detectSecretRead('Read', { file_path: '.ENVIRONMENT' }));

// --- end-to-end hook wire format ---
const d1 = runHook('Read', { file_path: '.env' });
ok('hook denies Read(.env) end-to-end (exit 2, block decision)', d1.code === 2 && /"decision":"block"/.test(d1.out));

const d2 = runHook('Bash', { command: 'cat .env' });
ok('hook denies Bash(cat .env) end-to-end (exit 2, block decision)', d2.code === 2 && /"decision":"block"/.test(d2.out));

const a1 = runHook('Read', { file_path: 'src/app.ts' });
ok('hook allows Read(src/app.ts) end-to-end (exit 0, no output)', a1.code === 0 && a1.out.trim() === '');

const a2 = runHook('Bash', { command: 'cd app && grep x pubspec.yaml' });
ok('hook allows Bash(cd app && grep x pubspec.yaml) end-to-end (exit 0, no output)', a2.code === 0 && a2.out.trim() === '');

// --- crash safety ---
const crash1 = runHook('Read', undefined);
ok('missing tool_input never crashes (exit 0)', crash1.code === 0);

console.log(`✓ secret-read-guard: ${passed} assertions passed`);
