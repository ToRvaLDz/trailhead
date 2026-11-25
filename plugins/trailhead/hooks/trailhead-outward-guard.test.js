#!/usr/bin/env node
// Tests for trailhead-outward-guard.js. Run: node trailhead-outward-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// TRAILHEAD_GUARD_HOOK re-runs this suite through the merged trailhead-bash-guards.js.
const HOOK = process.env.TRAILHEAD_GUARD_HOOK || path.join(__dirname, 'trailhead-outward-guard.js');
const { detectOutward, readOutward, readMarker, ticketVerdict, evaluate } = require('./trailhead-outward-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outward-guard-'));
const GLOBAL = path.join(tmp, 'global'); // CLAUDE_CONFIG_DIR
fs.mkdirSync(path.join(GLOBAL, 'trailhead'), { recursive: true });
const ENV = { CLAUDE_CONFIG_DIR: GLOBAL };
const setGlobal = (cfg) => {
  const f = path.join(GLOBAL, 'trailhead', 'config.json');
  if (cfg === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
};

let n = 0;
// A temp repo (.git dir); `cfg` is the project config (object, raw string or null), `marker` the
// session-ticket text (or null for none).
function repo(cfg, marker) {
  const dir = path.join(tmp, `repo${n++}`);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.trailhead'));
  if (cfg !== null) fs.writeFileSync(path.join(dir, '.trailhead', 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  if (marker !== null) fs.writeFileSync(path.join(dir, '.trailhead', 'session-ticket'), marker);
  return dir;
}

setGlobal(null);

// --- detectOutward: what matches -------------------------------------------
const hit = (c, extra) => detectOutward(c, { extra: extra || [] }) !== null;
for (const c of [
  'gh release create v1 --notes x',
  'gh -R o/r release create v1',
  'gh --repo o/r release create v1',
  'npm publish',
  'npm --prefix pkg publish --access public',
  'npm -C pkg publish',
  'pnpm publish',
  'pnpm --filter app publish',
  'yarn publish',
  'yarn npm publish',
  'git push --tags',
  'git push origin --tags',
  'git -C /x push --tags',
  'git -c user.name=x push origin --tags',
  'git push origin refs/tags/v1',
  'git push origin +refs/tags/v1',
  'git push origin main:refs/tags/v1',
  'git push origin tag v1',
  'sudo npm publish',
  'env X=1 npm publish',
  'NODE_ENV=production npm publish',
  'timeout 60 gh release create v1',
  'nice -n 5 pnpm publish',
  'cd pkg && npm publish',
  'git status; git push --tags',
  'bash -c "npm publish"',
  '/usr/bin/git push --tags',
  '(cd pkg && npm publish)',
  'cd pkg && (npm publish)',
  '{ npm publish; }',
  'if true; then npm publish; fi',
  'while x; do npm publish; done',
  'if x; then echo a; else git push --tags; fi',
  '! npm publish',
  'echo $(npm publish)',
  'echo `gh release create v1`',
  'x=$(cd pkg && pnpm publish)',
  'git push -n origin refs/tags/v1 && npm publish',
]) ok(`matches: ${c}`, hit(c));

// --- detectOutward: what does not ------------------------------------------
for (const c of [
  'git push',
  'git push origin main',
  'git push --force-with-lease',
  'git push --follow-tags',
  'git push origin v1',
  'npm pack',
  'npm run publish',
  'npm install publish',
  'gh release view v1',
  'gh release list',
  'gh issue create --title x',
  'echo "npm publish"',
  "echo 'git push --tags'",
  'cat <<EOF\nnpm publish\nEOF',
  'git commit -m "gh release create"',
  'ls',
  'npm publish --dry-run',
  'pnpm publish --dry-run',
  'git push --tags --dry-run',
  'git push -n origin refs/tags/v1',
  'gh release create --help',
  'npm publish -h',
  '(npm publish --dry-run)',
  'echo "(npm publish)"',
  'echo "$(echo npm publish)"',
  "echo '$(npm publish)'",
  'cat <<EOF\n(npm publish)\nEOF',
]) ok(`no match: ${c}`, !hit(c));

// --- detectOutward: configured commands ------------------------------------
ok('npm -n is not a dry run', hit('npm publish -n'));
ok('config prefix matches', hit('vercel deploy --prod --yes', ['vercel deploy --prod']));
ok('config prefix matches behind a wrapper', hit('sudo ./scripts/deploy.sh x', ['./scripts/deploy.sh']));
ok('config prefix is compared exactly (no basename folding)', !hit('/tmp/deploy.sh', ['./scripts/deploy.sh']));
ok('config prefix must be a prefix', !hit('vercel deploy', ['vercel deploy --prod']));
ok('config extends the defaults', hit('npm publish', ['vercel deploy --prod']));

// --- readOutward ------------------------------------------------------------
{
  const e = (cwd) => readOutward(cwd, ENV);
  setGlobal(null);
  let r = e(repo(null, null));
  ok('defaults: enabled, no extra commands', r.enabled === true && r.commands.length === 0);
  r = e(repo({ outward: { enabled: false, commands: ['a b'] } }, null));
  ok('nested keys', r.enabled === false && r.commands.join() === 'a b');
  r = e(repo({ 'outward.enabled': false, 'outward.commands': ['c d'] }, null));
  ok('flat keys', r.enabled === false && r.commands.join() === 'c d');
  r = e(repo({ outward: { commands: ['n x'] }, 'outward.commands': ['f y'] }, null));
  ok('nested wins over flat', r.commands.join() === 'n x');
  setGlobal({ outward: { enabled: false, commands: ['g z'] } });
  r = e(repo(null, null));
  ok('global applies without a project config', r.enabled === false && r.commands.join() === 'g z');
  r = e(repo({ outward: { enabled: true } }, null));
  ok('project wins over global, key by key', r.enabled === true && r.commands.join() === 'g z');
  r = e(repo({ outward: { enabled: 'no', commands: 'deploy' } }, null));
  ok('invalid values are ignored (global then applies)', r.enabled === false && r.commands.join() === 'g z');
  setGlobal(null);
  r = e(repo({ outward: { commands: ['ok x', '', 7, null, '  '] } }, null));
  ok('commands keeps only non-empty strings', r.commands.join() === 'ok x');
  r = e(repo('{ not json', null));
  ok('unreadable config -> defaults', r.enabled === true && r.commands.length === 0);
}

// --- readMarker --------------------------------------------------------------
{
  const f = path.join(tmp, 'marker.txt');
  const read = (s) => { fs.writeFileSync(f, s); return readMarker(f, (p) => fs.readFileSync(p, 'utf8')); };
  const m = read('#393 Block outward commands\nmore\n');
  ok('marker parses number and title', m.n === 393 && m.title === 'Block outward commands');
  ok('marker without title', read('#7').n === 7);
  ok('empty marker is malformed', read('').malformed === true);
  ok('no number is malformed', read('ticket 7').malformed === true);
  ok('unreadable marker is malformed', readMarker(path.join(tmp, 'nope'), (p) => fs.readFileSync(p, 'utf8')).malformed === true);
}

// --- ticketVerdict -----------------------------------------------------------
{
  const M = { n: 12, title: 'Ship it' };
  const data = (d) => () => ({ data: { state: 'OPEN', stateReason: '', labels: [], title: 'Ship it', ...d } });
  const code = (v) => (v ? v.payload.code : null);
  const reason = (v) => (v ? v.payload.reason : '');
  ok('open and clean -> allow', ticketVerdict(M, data({}), 'npm publish') === null);
  ok('unrelated labels -> allow', ticketVerdict(M, data({ labels: [{ name: 'bug' }] })) === null);
  let v = ticketVerdict(M, data({ state: 'CLOSED', stateReason: 'COMPLETED' }), 'npm publish');
  ok('closed -> block naming ticket and state', code(v) === 'OUTWARD_TICKET_DEAD' && /Ship it \(#12\)/.test(reason(v)) && /closed \(completed\)/.test(reason(v)));
  ok('block carries decision block', v.kind === 'block' && v.payload.decision === 'block');
  v = ticketVerdict(M, data({ labels: [{ name: 'trailhead:superseded' }] }));
  ok('superseded -> block', code(v) === 'OUTWARD_TICKET_DEAD' && /superseded/.test(reason(v)));
  v = ticketVerdict(M, data({ labels: [{ name: 'trailhead:paused' }] }));
  ok('paused -> block', code(v) === 'OUTWARD_TICKET_DEAD' && /paused/.test(reason(v)));
  v = ticketVerdict(M, data({ labels: [{ name: 'trailhead:out-of-scope' }] }));
  ok('out of scope -> block', code(v) === 'OUTWARD_TICKET_DEAD' && /out of scope/.test(reason(v)));
  v = ticketVerdict(M, data({ state: 'CLOSED', labels: [{ name: 'trailhead:paused' }, { name: 'trailhead:out-of-scope' }, { name: 'trailhead:superseded' }] }));
  ok('several dead states: superseded wins', /superseded/.test(reason(v)) && !/paused/.test(reason(v)));
  v = ticketVerdict(M, data({ state: 'CLOSED', labels: [{ name: 'trailhead:paused' }, { name: 'trailhead:out-of-scope' }] }));
  ok('out of scope beats closed and paused', /out of scope/.test(reason(v)));
  v = ticketVerdict(M, data({ state: 'CLOSED', labels: [{ name: 'trailhead:paused' }] }));
  ok('closed beats paused', /closed/.test(reason(v)));
  ok('reason says how to proceed', /remove \.trailhead\/session-ticket/.test(reason(v)));
  for (const [what, lookup] of [
    ['error result', () => ({ error: 'gh not found' })],
    ['throwing lookup', () => { throw new Error('boom'); }],
    ['no state', () => ({ data: {} })],
    ['empty result', () => null],
  ]) {
    v = ticketVerdict(M, lookup, 'npm publish');
    ok(`lookup failure (${what}) -> block`, code(v) === 'OUTWARD_TICKET_LOOKUP_FAILED' && /#12/.test(reason(v)) && /fix gh/i.test(reason(v)));
  }
  v = ticketVerdict(M, () => ({ error: 'timed out' }));
  ok('failure reason names why', /timed out/.test(reason(v)));
  v = ticketVerdict({ malformed: true }, data({}));
  ok('malformed marker -> block', code(v) === 'OUTWARD_MARKER_UNREADABLE');
}

// --- evaluate: end to end with a temp repo -----------------------------------
{
  let calls = 0;
  const live = () => { calls++; return { data: { state: 'OPEN', labels: [], title: 'Live' } }; };
  const dead = () => { calls++; return { data: { state: 'CLOSED', stateReason: 'NOT_PLANNED', labels: [], title: 'Dead' } }; };
  const ev = (cmd, cwd, lookup, extra) => evaluate(cmd, { cwd, env: ENV, lookup, ...(extra || {}) });

  let r = repo(null, null);
  calls = 0;
  ok('no marker -> allow, lookup never called', ev('npm publish', r, dead) === null && calls === 0);
  r = repo(null, '#5 Dead ticket\n');
  calls = 0;
  ok('non-matching command -> allow, lookup never called', ev('git push origin main', r, dead) === null && calls === 0);
  const v = ev('npm publish', path.join(r, 'sub'), dead);
  ok('dead ticket + match (from a subdir) -> block', v && v.payload.code === 'OUTWARD_TICKET_DEAD' && /Dead \(#5\)/.test(v.payload.reason) && calls === 1);
  ok('live ticket + match -> allow', ev('npm publish', r, live) === null);
  ok('dead ticket + failed lookup -> lookup-failed block', ev('gh release create v1', r, () => ({ error: 'HTTP 401' })).payload.code === 'OUTWARD_TICKET_LOOKUP_FAILED');
  ok('malformed marker blocks without calling gh', (() => {
    const bad = repo(null, 'oops');
    calls = 0;
    const x = ev('npm publish', bad, dead);
    return x.payload.code === 'OUTWARD_MARKER_UNREADABLE' && calls === 0;
  })());
  ok('empty marker blocks', ev('npm publish', repo(null, ''), live).payload.code === 'OUTWARD_MARKER_UNREADABLE');

  const off = repo({ outward: { enabled: false } }, '#5 Dead\n');
  calls = 0;
  ok('enabled:false -> allow, lookup never called', ev('npm publish', off, dead) === null && calls === 0);
  const cfg = repo({ outward: { commands: ['./scripts/deploy.sh'] } }, '#5 Dead\n');
  ok('configured command is held by a dead ticket', ev('./scripts/deploy.sh prod', cfg, dead).payload.code === 'OUTWARD_TICKET_DEAD');
  ok('defaults still apply with a configured list', ev('npm publish', cfg, dead).payload.code === 'OUTWARD_TICKET_DEAD');

  const gapCmd = "alias p='npm publish'; p";
  calls = 0;
  const gap = ev(gapCmd, repo(null, '#5 x\n'), live);
  ok('unmodelled construct hiding a listed command + marker -> rewrite block', gap && gap.payload.code === 'OUTWARD_UNMODELLED_CONSTRUCT' && /simple form/.test(gap.payload.reason) && calls === 0);
  ok('unmodelled construct without marker -> allow', ev(gapCmd, repo(null, null), live) === null);
  ok('unmodelled construct without a listed command -> allow', ev("alias ll='ls -l'; ll", repo(null, '#5 x\n'), live) === null);
  ok('eval of a listed command + marker -> block', ev('eval "git push --tags"', repo(null, '#5 x\n'), live).payload.code === 'OUTWARD_UNMODELLED_CONSTRUCT');

  ok('exists is injectable', ev('npm publish', repo(null, null), dead, { exists: () => true, readFile: () => '#9 Dead' }).payload.code === 'OUTWARD_TICKET_DEAD');
}

// --- hook end to end (real stdin/stdout, gh unavailable) ---------------------
{
  const run = (command, cwd) => {
    const input = JSON.stringify({ tool_input: { command }, cwd });
    const r = spawnSync(process.execPath, [HOOK], { input, cwd: tmp, env: { ...process.env, ...ENV, PATH: path.join(tmp, 'nobin') } });
    return { code: r.status, out: r.stdout.toString() };
  };
  const marked = repo(null, '#5 Some ticket\n');
  let r = run('npm publish', marked);
  ok('hook: lookup failure blocks (exit 2)', r.code === 2 && JSON.parse(r.out).code === 'OUTWARD_TICKET_LOOKUP_FAILED' && /gh not found/.test(JSON.parse(r.out).reason));
  r = run('npm publish', repo(null, null));
  ok('hook: no marker -> exit 0, empty stdout', r.code === 0 && r.out === '');
  r = run('git status', marked);
  ok('hook: unrelated command -> exit 0', r.code === 0 && r.out === '');
  const bad = spawnSync('node', [HOOK], { input: 'not json {{' });
  ok('hook: unparseable input -> exit 0', bad.status === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`trailhead-outward-guard: ${passed} checks passed`);
