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

// --- #180: docker/podman --env-file must not be treated as a secret read ---
// The container runtime reads the file itself; its contents never reach the
// agent, so `--env-file .env` (or `=`-glued) is not a secret READ by the
// agent, unlike every other flag/positional in the same statement.
ok('Bash docker run --env-file .env img is allowed (runtime reads it, not the agent)',
  !detectSecretRead('Bash', { command: 'docker run --env-file .env img' }));
ok('Bash docker compose --env-file .env.prod up is allowed',
  !detectSecretRead('Bash', { command: 'docker compose --env-file .env.prod up' }));
ok('Bash podman run --env-file=.env img is allowed (glued = form)',
  !detectSecretRead('Bash', { command: 'podman run --env-file=.env img' }));
ok('Bash docker-compose --env-file .env up is allowed (standalone binary)',
  !detectSecretRead('Bash', { command: 'docker-compose --env-file .env up' }));
ok('Bash bash -c "docker run --env-file .env img" is allowed (recursion into nested command)',
  !detectSecretRead('Bash', { command: 'bash -c "docker run --env-file .env img"' }));

// --- #180: everything else in a docker/podman statement is still scanned ---
ok('Bash cat .env is still denied', !!detectSecretRead('Bash', { command: 'cat .env' }));
ok('Bash foo --env-file .env is still denied (only docker/podman are exempt)',
  !!detectSecretRead('Bash', { command: 'foo --env-file .env' }));
ok('Bash foo --env-file=.env is still denied (only docker/podman are exempt)',
  !!detectSecretRead('Bash', { command: 'foo --env-file=.env' }));
ok('Bash docker run --env-file .env img && cat .env is still denied (second statement)',
  !!detectSecretRead('Bash', { command: 'docker run --env-file .env img && cat .env' }));
ok('Bash docker run -v x img cat .env is still denied (positional after image, conservative)',
  !!detectSecretRead('Bash', { command: 'docker run -v x img cat .env' }));
ok('Bash docker cp .env ctr:/x is still denied (plain positional, not --env-file)',
  !!detectSecretRead('Bash', { command: 'docker cp .env ctr:/x' }));

// --- end-to-end hook wire format ---
const d1 = runHook('Read', { file_path: '.env' });
ok('hook denies Read(.env) end-to-end (exit 2, block decision)', d1.code === 2 && /"decision":"block"/.test(d1.out));

const d2 = runHook('Bash', { command: 'cat .env' });
ok('hook denies Bash(cat .env) end-to-end (exit 2, block decision)', d2.code === 2 && /"decision":"block"/.test(d2.out));

const a1 = runHook('Read', { file_path: 'src/app.ts' });
ok('hook allows Read(src/app.ts) end-to-end (exit 0, no output)', a1.code === 0 && a1.out.trim() === '');

const a2 = runHook('Bash', { command: 'cd app && grep x pubspec.yaml' });
ok('hook allows Bash(cd app && grep x pubspec.yaml) end-to-end (exit 0, no output)', a2.code === 0 && a2.out.trim() === '');

// --- #180 end-to-end ---
const a3 = runHook('Bash', { command: 'docker run --env-file .env img' });
ok('hook allows Bash(docker run --env-file .env img) end-to-end (exit 0, no output)', a3.code === 0 && a3.out.trim() === '');

const a4 = runHook('Bash', { command: 'docker compose --env-file .env.prod up' });
ok('hook allows Bash(docker compose --env-file .env.prod up) end-to-end (exit 0, no output)', a4.code === 0 && a4.out.trim() === '');

const a5 = runHook('Bash', { command: 'podman run --env-file=.env img' });
ok('hook allows Bash(podman run --env-file=.env img) end-to-end (exit 0, no output)', a5.code === 0 && a5.out.trim() === '');

const d3 = runHook('Bash', { command: 'cat .env' });
ok('hook still denies Bash(cat .env) end-to-end (exit 2, block decision)', d3.code === 2 && /"decision":"block"/.test(d3.out));

// --- template env files (.env.example/.sample/.template/.dist) are not secrets ---
const allowCmd = (c) => ok(`Bash \`${c}\` is allowed`, !detectSecretRead('Bash', { command: c }));
const denyCmd = (c) => ok(`Bash \`${c}\` is denied`, !!detectSecretRead('Bash', { command: c }));
ok('Read .env.example is allowed', !detectSecretRead('Read', { file_path: '.env.example' }));
ok('Read .env.local.example is allowed', !detectSecretRead('Read', { file_path: 'app/.env.local.example' }));
ok('Read .ENV.SAMPLE is allowed', !detectSecretRead('Read', { file_path: '.ENV.SAMPLE' }));
allowCmd('cat .env.template');
allowCmd('cat .env.dist');
ok('Read .env.example.bak is still denied', !!detectSecretRead('Read', { file_path: '.env.example.bak' }));
ok('Read .env.examples is still denied', !!detectSecretRead('Read', { file_path: '.env.examples' }));

// --- name-only operand positions: git pathspecs, cp/mv destination ---
// Questi comandi non stampano mai il contenuto del file: sono i controlli che
// tengono un segreto fuori da git, e il guard non deve bloccarli.
allowCmd('git check-ignore -v .env');
allowCmd('git check-ignore -q .env .secrets');
allowCmd('git ls-files --error-unmatch .env');
allowCmd('git ls-files -ci --exclude-standard -- .env');
allowCmd('git rm --cached .env');
allowCmd('git rm -r --cached -f .env');
allowCmd('git -C app check-ignore .env');
allowCmd('git --no-pager ls-files .env');
allowCmd('cp .env.example .env');
allowCmd('cp -f .env.example .env');
allowCmd('mv .env.sample .env');
allowCmd('cp -- .env.example .env');
allowCmd('git check-ignore .env && cp .env.example .env');
// Fail-closed: forme che leggono, o fuori dal set di opzioni chiuso.
denyCmd('git show HEAD:.env');
denyCmd('git rm .env');
denyCmd('git rm -- --cached .env');
denyCmd('git rm --cached --pathspec-from-file=.env');
denyCmd('git ls-files -X .env');
denyCmd('git ls-files -ciX .env');
denyCmd('git -C ls-files show HEAD:.env');
denyCmd('git --unknown check-ignore .env');
denyCmd('git diff .env');
denyCmd('cp .env /tmp/x');
denyCmd('cp .env .env.bak');
denyCmd('mv .env /tmp/x');
denyCmd('cp -t /tmp .env.example .env');
denyCmd('cp .env.example .env /tmp');
denyCmd('cp -b .env.example .env');
denyCmd('cp --backup .env.example .env');
denyCmd('cp -l .env.example .env');
denyCmd('cp -s .env.example .env');
denyCmd('mv --exchange .env.example .env');
denyCmd('cp .env.example .env -f');
denyCmd('cp .env.example .env && cat .env');
denyCmd('git check-ignore .env; cat .env');

const a6 = runHook('Bash', { command: 'git check-ignore -v .env' });
ok('hook allows Bash(git check-ignore -v .env) end-to-end (exit 0, no output)', a6.code === 0 && a6.out.trim() === '');
const a7 = runHook('Bash', { command: 'cp .env.example .env' });
ok('hook allows Bash(cp .env.example .env) end-to-end (exit 0, no output)', a7.code === 0 && a7.out.trim() === '');

// --- crash safety ---
const crash1 = runHook('Read', undefined);
ok('missing tool_input never crashes (exit 0)', crash1.code === 0);

console.log(`✓ secret-read-guard: ${passed} assertions passed`);
