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
