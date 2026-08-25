#!/usr/bin/env node
// Tests for trailhead-install-guard.js. Run: node trailhead-install-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const HOOK = path.join(__dirname, 'trailhead-install-guard.js');
const { detectInstall, isVerified } = require('./trailhead-install-guard.js');

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

// --- unit: detectInstall positives (a NAMED public-registry install) ---
const pos = [
  ['npm install lodash', 'npm', 'lodash'],
  ['npm i react', 'npm', 'react'],
  ['pnpm add vite', 'npm', 'vite'],
  ['yarn add left-pad', 'npm', 'left-pad'],
  ['bun add hono', 'npm', 'hono'],
  ['pip install requests', 'pip', 'requests'],
  ['pip3 install numpy', 'pip', 'numpy'],
  ['python -m pip install flask', 'pip', 'flask'],
  ['python3 -m pip install flask', 'pip', 'flask'],
  ['uv add httpx', 'pip', 'httpx'],
  ['uv pip install httpx', 'pip', 'httpx'],
  ['poetry add django', 'pip', 'django'],
  ['pipx install black', 'pip', 'black'],
  ['cargo add serde', 'crates', 'serde'],
  ['cargo install ripgrep', 'crates', 'ripgrep'],
  ['go get example.com/foo/bar', 'go', 'example.com/foo/bar'],
  ['go install golang.org/x/tools/cmd/stringer', 'go', 'golang.org/x/tools/cmd/stringer'],
  ['gem install rails', 'gem', 'rails'],
];
for (const [cmd, eco, name] of pos) {
  const d = detectInstall(cmd);
  ok(`detects: ${cmd}`, d && d.ecosystem === eco && d.packages.includes(name));
}

// Scoped and versioned names are still names (bare name reported).
ok('detects scoped npm name', (() => { const d = detectInstall('npm install @scope/pkg'); return d && d.packages[0] === '@scope/pkg'; })());
ok('strips npm @version', (() => { const d = detectInstall('npm install lodash@4.17.21'); return d && d.packages[0] === 'lodash'; })());
ok('strips pip == specifier', (() => { const d = detectInstall('pip install requests==2.0'); return d && d.packages[0] === 'requests'; })());
ok('strips pip extra', (() => { const d = detectInstall('pip install requests[security]'); return d && d.packages[0] === 'requests'; })());
ok('scoped versioned npm keeps scope', (() => { const d = detectInstall('npm install @scope/pkg@1.2.3'); return d && d.packages[0] === '@scope/pkg'; })());

// --- unit: detectInstall negatives (no typed registry name) ---
const neg = [
  'npm install',                     // bare: from package.json/lock
  'npm ci',                          // lockfile install
  'pip install -r requirements.txt', // requirements file
  'pip install --requirement req.txt',
  'pip install -e .',                // editable local
  'npm install ./local-tarball.tgz', // local path
  'npm install file:../pkg',         // file: ref
  'cargo build',                     // not an install verb
  'go mod download',                 // not get/install
  'bundle install',                  // unrecognised binary
  'pip install git+https://github.com/x/y', // vcs url
  'npm install --save-dev',          // flag only, no name
  'ls -la',                          // unrelated
  'go build ./...',                  // not get/install
];
for (const cmd of neg) {
  ok(`ignores: ${cmd}`, detectInstall(cmd) === null);
}

// `-r`'s value must not be read as a package even with a trailing name absent.
ok('consumes -r value, no phantom name', detectInstall('pip install -r requirements.txt') === null);

// Compound commands: an install in any segment is caught, not just the first.
ok('detects install after && chain', (() => { const d = detectInstall('cd app && npm install lodash'); return d && d.packages.includes('lodash'); })());
ok('detects install after ; chain', (() => { const d = detectInstall('echo hi; pip install requests'); return d && d.packages.includes('requests'); })());
ok('detects install in a piped tail', (() => { const d = detectInstall('true | cargo add serde'); return d && d.packages.includes('serde'); })());
ok('compound with no install stays null', detectInstall('cd app && npm run build && ls') === null);

// --- unit: isVerified ---
ok('sentinel recognised', isVerified('TRAILHEAD_VERIFIED_INSTALL=1 npm install lodash'));
ok('no sentinel', !isVerified('npm install lodash'));

// --- end-to-end: block ---
const b1 = runHook('npm install lodash');
ok('blocks an unvetted named install (exit 2)', b1.code === 2 && /UNVETTED_PACKAGE_INSTALL/.test(b1.out));
ok('block names the package', /lodash/.test(b1.out) && /"decision":"block"/.test(b1.out));
const b2 = runHook('pip install some-obscure-pkg');
ok('blocks a pip named install (exit 2)', b2.code === 2 && /some-obscure-pkg/.test(b2.out));

// --- end-to-end: allow ---
const a1 = runHook('TRAILHEAD_VERIFIED_INSTALL=1 npm install lodash');
ok('sentinel allows a vetted install (exit 0)', a1.code === 0 && a1.out.trim() === '');
const a2 = runHook('npm install');
ok('bare install allowed (exit 0)', a2.code === 0 && a2.out.trim() === '');
const a3 = runHook('ls -la');
ok('non-install allowed (exit 0)', a3.code === 0 && a3.out.trim() === '');
const a4 = runHook('pip install -r requirements.txt');
ok('requirements-file install allowed (exit 0)', a4.code === 0 && a4.out.trim() === '');

// --- end-to-end: unparseable stdin allowed ---
const u = (() => {
  try {
    const out = execFileSync('node', [HOOK], { input: 'not json' });
    return { code: 0, out: out.toString() };
  } catch (e) { return { code: e.status, out: (e.stdout || '').toString() }; }
})();
ok('unparseable stdin allowed (exit 0)', u.code === 0);

console.log(`✓ install-guard: ${passed} assertions passed`);
