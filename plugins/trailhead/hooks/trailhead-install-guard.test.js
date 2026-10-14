#!/usr/bin/env node
// Tests for trailhead-install-guard.js. Run: node trailhead-install-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// TRAILHEAD_GUARD_HOOK re-runs this suite through the merged trailhead-bash-guards.js.
const HOOK = process.env.TRAILHEAD_GUARD_HOOK || path.join(__dirname, 'trailhead-install-guard.js');
const { detectInstall, isVerified, evaluate } = require('./trailhead-install-guard.js');

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

// --- unit: lockfile installs, redirections, quoted text (#239) ---
const heredocDoc = ['cat > /tmp/x.md <<\'EOF\'', '| `pnpm install a 2>&1` | x |', 'EOF'].join('\n');
const neg239 = [
  'pnpm install --frozen-lockfile --offline 2>&1',
  'cd app && pnpm install --frozen-lockfile --offline 2>&1 | tail -5',
  'pnpm install --frozen-lockfile > /tmp/log',
  'pnpm install --frozen-lockfile --filter web',
  'pnpm install --frozen-lockfile',
  'yarn install --immutable',
  'bun install --frozen-lockfile',
  'yarn install --frozen-lockfile',
  'npm install 2>&1',
  'echo "done; pnpm install lodash"',
  'echo "a && npm install foo"',
  'echo "next: pnpm install then build"',
  'git commit -m "fix: pnpm install guard | npm i x"',
  heredocDoc,
];
for (const cmd of neg239) {
  ok(`ignores: ${cmd.split('\n')[0]}`, detectInstall(cmd) === null);
}

// Redirections and quoting must not hide a real named install, nor leak into the name.
const pos239 = [
  ['npm install lodash 2>&1', 'npm', ['lodash']],
  ['pnpm add vite > /tmp/log', 'npm', ['vite']],
  ['npm install "lodash"', 'npm', ['lodash']],
  ['echo ok && npm install lodash', 'npm', ['lodash']],
  ['echo ok; pip install requests', 'pip', ['requests']],
  ['pnpm add --filter web vite', 'npm', ['vite']],
];
for (const [cmd, eco, names] of pos239) {
  const d = detectInstall(cmd);
  ok(`detects exactly: ${cmd}`, d && d.ecosystem === eco && JSON.stringify(d.packages) === JSON.stringify(names));
}

// A lockfile flag never excuses a typed name: the named package is still gated.
const posLock = [
  ['npm i --frozen-lockfile evilpkg', 'evilpkg'],
  ['pnpm install --frozen-lockfile evilpkg', 'evilpkg'],
  ['yarn install --immutable evilpkg', 'evilpkg'],
  ['npm install evilpkg --frozen', 'evilpkg'],
];
for (const [cmd, name] of posLock) {
  const d = detectInstall(cmd);
  ok(`detects despite lockfile flag: ${cmd}`, d && d.packages.includes(name));
  const r = runHook(cmd);
  ok(`blocks despite lockfile flag: ${cmd}`, r.code === 2 && new RegExp(name).test(r.out));
}

// A bare `&` (background) is never listed as a package name.
ok('background & is not a package', JSON.stringify((detectInstall('npm install lodash &') || {}).packages) === JSON.stringify(['lodash']));

// --- unit: wrapped installs and file-like names (#255) ---
const posWrap = [
  ['sudo npm install lodash', 'lodash'],
  ['time pip install requests', 'requests'],
  ['env FOO=1 npm i lodash', 'lodash'],
  ['nohup npm install lodash', 'lodash'],
  ['xargs npm install lodash', 'lodash'],
  ['sudo -u bob npm install lodash', 'lodash'],   // flag with a separate-token value
  ['sudo -- npm i lodash', 'lodash'],
  ['sudo -E npm i lodash', 'lodash'],
  ['env -u HOME npm i lodash', 'lodash'],
  ['env -C /tmp FOO=1 npm i lodash', 'lodash'],
  ['time -p pip install requests', 'requests'],
  ['time -o /tmp/t pip install requests', 'requests'],
  ['xargs -n 1 npm install lodash', 'lodash'],
  ['xargs -I {} pip install requests', 'requests'],
  ['xargs --max-args=1 npm i lodash', 'lodash'],
  ['sudo env FOO=1 nohup npm i lodash', 'lodash'],   // chain
  ['FOO=1 sudo -u root time -p pip install requests', 'requests'],
  ['cd app && sudo npm install lodash', 'lodash'],
  ['/usr/bin/sudo npm install lodash', 'lodash'],
  ['sudo -nu root npm i lodash', 'lodash'],      // bundled short flags, value flag last
  ['sudo -Eu bob npm i lodash', 'lodash'],
  ['sudo -iu root npm i lodash', 'lodash'],
  ['sudo -uroot npm i lodash', 'lodash'],        // attached value
  ['sudo -nE npm i lodash', 'lodash'],           // cluster with no value flag
  ['env -S "npm i lodash"', 'lodash'],           // split-string payload is the command
  ['env -S npm i lodash', 'lodash'],
  ["env -S 'npm i lodash'", 'lodash'],
  ['env --split-string="npm i lodash"', 'lodash'],
  ['env --split-string npm i lodash', 'lodash'],
  ['env -a name npm i lodash', 'lodash'],        // argv0 value, command follows
  ['env -S "FOO=1 sudo npm i lodash"', 'lodash'],
];
for (const [cmd, name] of posWrap) {
  const d = detectInstall(cmd);
  ok(`detects wrapped: ${cmd}`, d && d.packages.includes(name));
}
const negWrap = [
  'sudo npm install',
  'sudo npm ci',
  'time npm install --frozen-lockfile',
  'env FOO=1 npm install',
  'xargs echo npm install foo',     // xargs runs echo
  'sudo -u bob ls',
  'sudo',
  'env',
  'sudo -u',
  'sudo -nu root ls',
  'env -S "ls -la"',
  'env -S "npm install"',
];
for (const cmd of negWrap) {
  ok(`ignores wrapped: ${cmd}`, detectInstall(cmd) === null);
}

// A file-like suffix is local only for a path or an existing file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-guard-'));
fs.writeFileSync(path.join(tmp, 'foo.tgz'), '');
const inTmp = { cwd: tmp };
const posFile = ['pip install foo.txt', 'npm install left-pad.toml', 'npm install nope.tgz', 'pip install pkg.whl'];
for (const cmd of posFile) {
  const d = detectInstall(cmd, inTmp);
  ok(`gates absent file-like name: ${cmd}`, d && d.packages.length === 1);
}
const negFile = [
  'pip install ./foo.txt',
  'pip install sub/req.txt',
  'pip install /abs/req.txt',
  'pip install ~/req.txt',
  'npm install foo.tgz',            // exists in cwd
];
for (const cmd of negFile) {
  ok(`allows path or existing file: ${cmd}`, detectInstall(cmd, inTmp) === null);
}
ok('existing file resolved against cwd, not process cwd', detectInstall('npm install foo.tgz', { cwd: os.tmpdir() }) !== null);
ok('injectable exists check', detectInstall('npm install x.tgz', { exists: () => true }) === null);
ok('scoped name is never a path', (() => { const d = detectInstall('npm install @scope/pkg.zip', inTmp); return d && d.packages[0] === '@scope/pkg.zip'; })());
ok('evaluate tolerates null opts', evaluate('npm install lodash', null).kind === 'block');
const wf = evaluate('npm install foo.tgz', { cwd: tmp });
ok('evaluate threads cwd (existing file allowed)', wf.kind === 'allow');
ok('evaluate blocks absent file-like name', evaluate('pip install foo.txt', { cwd: tmp }).kind === 'block');
const wrapRun = runHook('sudo npm install lodash');
ok('blocks a sudo-wrapped install end-to-end (exit 2)', wrapRun.code === 2 && /lodash/.test(wrapRun.out));
const cwdRun = (() => {
  const input = JSON.stringify({ cwd: tmp, tool_input: { command: 'npm install foo.tgz' } });
  try { return { code: 0, out: execFileSync('node', [HOOK], { input }).toString() }; } catch (e) { return { code: e.status }; }
})();
ok('hook honours input.cwd for the on-disk check (exit 0)', cwdRun.code === 0);
fs.rmSync(tmp, { recursive: true, force: true });

// Wrappers peeled with their flags: timeout (+ DURATION), nice, stdbuf, setsid, ionice, doas, command, exec.
const wrapHits = [
  'timeout 10 npm i x', 'timeout -s KILL 10 npm i x', 'timeout --signal=KILL 5s npm i x',
  'timeout -k 1 10 npm i x', 'nice npm i x', 'nice -n 5 npm i x', 'nice -n5 npm i x', 'nice -5 npm i x',
  'command npm i x', 'command -p npm i x', 'exec npm i x', 'exec -a foo npm i x',
  'doas npm i x', 'doas -u root npm i x', 'setsid npm i x', 'setsid -w npm i x',
  'ionice -c 3 npm i x', 'stdbuf -oL npm i x', 'stdbuf -o L npm i x',
  'sudo timeout 10 nice npm i x', 'xargs timeout 10 npm i x', 'timeout -- 10 npm i x',
  'env -S "env -S \\"npm i lodash\\""',
  'env -S "env -S \\"env -S \\\\\\"npm i lodash\\\\\\"\\""',
  "env -S 'npm i lodash'",
];
for (const c of wrapHits) ok(`wrapper hit: ${c}`, detectInstall(c) && detectInstall(c).packages.length > 0);
const wrapMisses = [
  'timeout 10 ls', 'nice ls', 'command -v npm', 'command -v npm i x', 'command -V npm i x',
  'command -pv npm i x', 'exec 3>&1', 'exec -a npm ls', 'doas ls',
  "env -S 'echo \"npm i lodash\"'", 'env -S "echo \\"npm i lodash\\""',
];
for (const c of wrapMisses) ok(`wrapper miss: ${c}`, detectInstall(c) === null);

// Known unmodelled gaps (documented, NOT asserted): this guard reads one plain
// command per statement plus the wrappers it peels, so an install behind
// `bash -c "..."` / `sh -c "..."`, `$( )`, `eval`, other wrappers (`chrt`,
// `taskset`, `flock`, `su -c`), or a GNU long-option prefix abbreviation
// taking a separate value (`timeout --sig KILL 5 ...`) is not seen.

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

const a5 = runHook('cd app && pnpm install --frozen-lockfile --offline 2>&1 | tail -5');
ok('lockfile install with redirection allowed (exit 0)', a5.code === 0 && a5.out.trim() === '');
const a6 = runHook('echo "done; pnpm install lodash"');
ok('install text inside echo allowed (exit 0)', a6.code === 0 && a6.out.trim() === '');
const b3 = runHook('npm install lodash 2>&1');
ok('named install with redirection still blocks (exit 2)', b3.code === 2 && /lodash/.test(b3.out));

// --- end-to-end: unparseable stdin allowed ---
const u = (() => {
  try {
    const out = execFileSync('node', [HOOK], { input: 'not json' });
    return { code: 0, out: out.toString() };
  } catch (e) { return { code: e.status, out: (e.stdout || '').toString() }; }
})();
ok('unparseable stdin allowed (exit 0)', u.code === 0);

console.log(`✓ install-guard: ${passed} assertions passed`);
