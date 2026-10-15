#!/usr/bin/env node
// Tests for templates/trailhead-uat-setup.js. Run: node uat-setup.test.js
// No framework: plain asserts, same style as base-preflight.test.js. Real temp dirs.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-uat-setup.js');
const { main, parseArgs } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, actual, expected) => {
  assert.deepStrictEqual(actual, expected, `${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  passed++;
};

const tmpDirs = [];
const mktmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-uat-setup-test-')));
  tmpDirs.push(d);
  return d;
};
const writeConfig = (root, obj) => {
  fs.mkdirSync(path.join(root, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(root, '.trailhead', 'config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
};

function run(argv, { env = {}, cwd = '/' } = {}) {
  const chunks = [];
  const errChunks = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errChunks.push(String(s)); return true; };
  let code;
  try {
    code = main(argv, { cwd, env: { HOME: '/nonexistent-home', ...env }, stdout: { write: (s) => chunks.push(s) } });
  } finally {
    process.stderr.write = realErr;
  }
  const lines = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code, out: lines[0], lines, err: errChunks.join('') };
}

const emptyHome = mktmp();
const envNoGlobal = { CLAUDE_CONFIG_DIR: emptyHome };
const plan = (dir, extra = [], env = {}) => run(['plan', '--repo', dir, ...extra], { env: { ...envNoGlobal, ...env } });
const go = (dir, extra = [], env = {}) => run(['run', '--repo', dir, ...extra], { env: { ...envNoGlobal, ...env } });
const proj = (cfg) => { const d = mktmp(); if (cfg !== undefined) writeConfig(d, cfg); return d; };

// --- usage ----------------------------------------------------------------------
{
  ok('parseArgs: missing command', parseArgs([]).error);
  ok('parseArgs: unknown command', parseArgs(['nope', '--repo', '/x']).error);
  ok('parseArgs: missing --repo', parseArgs(['plan']).error);
  ok('parseArgs: unknown flag', parseArgs(['plan', '--repo', '/x', '--bogus']).error);
  ok('parseArgs: valueless flag', parseArgs(['plan', '--repo']).error);
  ok('parseArgs: --only and --from are exclusive', parseArgs(['run', '--repo', '/x', '--only', '0', '--from', '1']).error);
  ok('parseArgs: bad timeout', parseArgs(['run', '--repo', '/x', '--ready-timeout', 'abc']).error);
  for (const v of ['Infinity', '1e999', '-1', '0', 'NaN']) {
    ok(`parseArgs: --step-timeout ${v} rejected`, parseArgs(['run', '--repo', '/x', '--step-timeout', v]).error);
    ok(`parseArgs: --ready-timeout ${v} rejected`, parseArgs(['run', '--repo', '/x', '--ready-timeout', v]).error);
  }
  ok('parseArgs: fractional timeout accepted', !parseArgs(['run', '--repo', '/x', '--step-timeout', '0.5']).error);
  const inf = run(['run', '--repo', '/x', '--step-timeout', 'Infinity']);
  eq('infinite timeout exits 2 with no stdout', [inf.code, inf.lines.length], [2, 0]);
  const r = run([]);
  eq('usage error exits 2', r.code, 2);
  ok('usage error writes stderr, no stdout', r.err.includes('usage') && r.lines.length === 0);
}

// --- config reading -------------------------------------------------------------
{
  eq('unset: unconfigured', plan(proj()).out.status, 'unconfigured');
  eq('no uat key: unconfigured', plan(proj({ testing: { webapp: true } })).out.status, 'unconfigured');
  const none = plan(proj({ uat: { setup: [] } }));
  eq('[]: none', [none.out.status, none.code], ['none', 0]);
  eq('[]: run is none too', go(proj({ uat: { setup: [] } })).out.status, 'none');
  eq('unconfigured run runs nothing', go(proj()).out.status, 'unconfigured');
  const nested = plan(proj({ uat: { setup: [{ name: 'a', run: 'true' }] } }));
  eq('nested: ready to plan', [nested.out.status, nested.out.steps.length], ['ready', 1]);
  const flat = plan(proj({ 'uat.setup': [{ name: 'a', run: 'true' }, { name: 'b', run: 'true' }] }));
  eq('flat: read', flat.out.steps.length, 2);
  const both = plan(proj({ uat: { setup: [{ name: 'n', run: 'true' }] }, 'uat.setup': [{ name: 'f', run: 'true' }] }));
  eq('both: nested wins', both.out.steps[0].name, 'n');
  ok('both: a warning', both.out.warnings.some((w) => /nested/.test(w)));
  const bad = plan(proj('{not json'));
  eq('unparseable file: invalid', bad.out.status, 'invalid');
}

// --- project replaces global, key by key ----------------------------------------
{
  const home = mktmp();
  fs.mkdirSync(path.join(home, 'trailhead'));
  fs.writeFileSync(path.join(home, 'trailhead', 'config.json'), JSON.stringify({
    uat: { setup: [{ name: 'global', run: 'true' }], accounts: { qa: { user: 'g@x.io', secret: '$G_PW' } } },
  }));
  const env = { CLAUDE_CONFIG_DIR: home };
  const onlyGlobal = run(['plan', '--repo', proj()], { env });
  eq('global only: setup from global', onlyGlobal.out.steps[0].name, 'global');
  const p = proj({ uat: { setup: [{ name: 'project', run: 'true' }] } });
  const mixed = run(['plan', '--repo', p], { env });
  eq('project setup replaces global setup', mixed.out.steps.map((s) => s.name), ['project']);
  eq('accounts still resolved from global', mixed.out.accounts.map((a) => a.role), ['qa']);
  const empty = run(['plan', '--repo', proj({ uat: { setup: [] } })], { env });
  eq('project [] replaces a global list', empty.out.status, 'none');
  const wt = mktmp();
  const viaRoot = run(['plan', '--repo', wt, '--config-root', p], { env });
  eq('--config-root supplies the project file', viaRoot.out.steps[0].name, 'project');
}

// --- validation -----------------------------------------------------------------
{
  const invalid = (name, cfg) => {
    const r = go(proj(cfg));
    eq(`invalid: ${name}`, [r.out.status, r.code], ['invalid', 0]);
    ok(`invalid: ${name} has a message`, typeof r.out.message === 'string' && r.out.message.length > 0);
  };
  invalid('setup not an array', { uat: { setup: 'make up' } });
  invalid('step not an object', { uat: { setup: ['make up'] } });
  invalid('step without run', { uat: { setup: [{ name: 'a' }] } });
  invalid('step without name', { uat: { setup: [{ run: 'true' }] } });
  invalid('empty name', { uat: { setup: [{ name: ' ', run: 'true' }] } });
  invalid('non-string check', { uat: { setup: [{ name: 'a', run: 'true', check: 1 }] } });
  invalid('unknown key', { uat: { setup: [{ name: 'a', run: 'true', extra: 1 }] } });
  invalid('accounts not an object', { uat: { accounts: [] } });
  invalid('uat is a string', { uat: 'x' });
  invalid('uat is an array', { uat: [] });
  invalid('uat is null', { uat: null });
  invalid('account without secret', { uat: { setup: [], accounts: { qa: { user: 'u' } } } });
  invalid('account without user', { uat: { setup: [], accounts: { qa: { secret: '$X' } } } });
  invalid('literal secret rejected', { uat: { setup: [], accounts: { qa: { user: 'u', secret: 'hunter2' } } } });
  invalid('secret embedded in text rejected', { uat: { setup: [], accounts: { qa: { user: 'u', secret: 'pw-$X' } } } });
  invalid('unknown account key', { uat: { setup: [], accounts: { qa: { user: 'u', secret: '$X', extra: 1 } } } });
  const okAcc = plan(proj({ uat: { setup: [], accounts: { qa: { user: 'u@x.io', secret: '${QA_PW}' }, dev: { user: '$DEV_USER', secret: '$DEV_PW' } } } }), [], { QA_PW: 'sekret-1' });
  eq('literal user and bare refs accepted', okAcc.out.status, 'none');
  // invalid accounts must not run an otherwise good setup
  const marker = path.join(mktmp(), 'ran');
  const r = go(proj({ uat: { setup: [{ name: 'a', run: `touch ${marker}` }], accounts: { qa: { user: 'u', secret: 'literal' } } } }));
  eq('invalid accounts: nothing runs', [r.out.status, fs.existsSync(marker)], ['invalid', false]);
}

// --- plan -----------------------------------------------------------------------
{
  const d = proj({ uat: {
    setup: [
      { name: 'db', run: 'docker compose up -d db', check: 'true', note: 'ask before using the Pixel' },
      { name: 'app', run: 'DEVICE=$ADB_DEVICE npm start --token ${API_TOKEN}' },
    ],
    accounts: { qa: { user: 'qa@x.io', secret: '$QA_PW' }, dev: { user: '$DEV_USER', secret: '${DEV_PW}' } },
  } });
  const r = plan(d, [], { ADB_DEVICE: 'emulator-5554', QA_PW: 'topsecret' });
  eq('plan: steps', r.out.steps.map((s) => [s.index, s.name, s.note || null, s.check]), [[0, 'db', 'ask before using the Pixel', true], [1, 'app', null, false]]);
  eq('plan: step env presence', r.out.steps[1].env, [{ name: 'ADB_DEVICE', set: true }, { name: 'API_TOKEN', set: false }]);
  eq('plan: accounts', r.out.accounts, [
    { role: 'qa', user: 'qa@x.io', userEnv: null, secretEnv: { name: 'QA_PW', set: true } },
    { role: 'dev', user: null, userEnv: { name: 'DEV_USER', set: false }, secretEnv: { name: 'DEV_PW', set: false } },
  ]);
  ok('plan: never prints a value', !JSON.stringify(r.out).includes('emulator-5554') && !JSON.stringify(r.out).includes('topsecret'));
  const marker = path.join(mktmp(), 'ran');
  plan(proj({ uat: { setup: [{ name: 'a', run: `touch ${marker}` }] } }));
  ok('plan never runs anything', !fs.existsSync(marker));
}

// --- run ------------------------------------------------------------------------
{
  const dir = mktmp();
  const f = (n) => path.join(dir, n);
  const d = proj({ uat: { setup: [
    { name: 'up', run: `touch ${f('up')}`, check: `test -f ${f('up')}` },
    { name: 'always', run: `echo x >> ${f('log')}` },
  ] } });
  const first = go(d);
  eq('run: failing check runs the step, then ready', [first.out.status, first.out.steps.map((s) => s.result)], ['ready', ['ran', 'ran']]);
  const second = go(d);
  eq('run: passing check skips, no check always runs', second.out.steps.map((s) => s.result), ['skipped', 'ran']);
  eq('run: always step ran twice', fs.readFileSync(f('log'), 'utf8').split('\n').filter(Boolean).length, 2);
  ok('run: ok steps carry no output', second.out.steps.every((s) => s.output === undefined));
}
{
  const dir = mktmp();
  const f = (n) => path.join(dir, n);
  const d = proj({ uat: { setup: [
    { name: 's0', run: `touch ${f('s0')}` },
    { name: 's1', run: 'echo boom-visible; exit 3' },
    { name: 's2', run: `touch ${f('s2')}` },
  ] } });
  const r = go(d);
  eq('failed: status and failedStep', [r.out.status, r.out.failedStep], ['failed', 1]);
  eq('failed: step result carries code and output', [r.out.steps[1].result, r.out.steps[1].code, r.out.steps[1].output.trim()], ['failed', 3, 'boom-visible']);
  eq('failed: stops at the first failure', [fs.existsSync(f('s0')), fs.existsSync(f('s2')), r.out.steps.length], [true, false, 2]);
  fs.unlinkSync(f('s0'));
  const from = go(d, ['--from', '1']);
  eq('--from skips the earlier steps', [from.out.steps[0].index, fs.existsSync(f('s0'))], [1, false]);
  const only = go(proj({ uat: { setup: [{ name: 'a', run: `touch ${f('oa')}` }, { name: 'b', run: `touch ${f('ob')}` }] } }), ['--only', '1']);
  eq('--only runs exactly one', [only.out.status, only.out.steps.map((s) => s.index), fs.existsSync(f('oa')), fs.existsSync(f('ob'))], ['ready', [1], false, true]);
  eq('--only out of range: invalid', go(d, ['--only', '9']).out.status, 'invalid');
  const cwdProbe = go(proj({ uat: { setup: [{ name: 'cwd', run: 'pwd > cwd.txt' }] } }), []);
  ok('run cwd is --repo', cwdProbe.out.status === 'ready');
}
{
  const dir = mktmp();
  const marker = path.join(dir, 'ran');
  const d = proj({ uat: { setup: [
    { name: 'needs', run: `touch ${marker}; echo $MISSING_ONE ${'${MISSING_TWO}'}`, check: 'false' },
  ] } });
  const r = go(d, [], { MISSING_ONE: '' });
  eq('missing-env: failed and names the variables', [r.out.status, r.out.steps[0].result, r.out.steps[0].missing], ['failed', 'missing-env', ['MISSING_ONE', 'MISSING_TWO']]);
  ok('missing-env runs nothing', !fs.existsSync(marker));
}
{
  // shell-local $names are not env references: single quotes and \$ escape
  const marker = path.join(mktmp(), 'ran');
  const pl = plan(proj({ uat: { setup: [{ name: 'local', run: "for f in a b; do echo \\$f; done; awk '{print $NF}' </dev/null; echo '$QUOTED'; echo \\$ESC; echo \"\\$ESC2\"; echo $REAL", check: "echo '${Q2}' >/dev/null" }] } }), [], { REAL: 'v' });
  eq('plan: only unquoted, unescaped refs listed', pl.out.steps[0].env.map((e) => e.name), ['REAL']);
  const loc = go(proj({ uat: { setup: [{ name: 'local', run: `awk '{print $NF}' </dev/null; echo '$NOPE_UNSET' >/dev/null; echo \\$NOPE_UNSET2 >/dev/null; touch ${marker}` }] } }));
  eq('run: single-quoted and escaped refs need no env', [loc.out.status, loc.out.steps[0].result, fs.existsSync(marker)], ['ready', 'ran', true]);
  const dq = go(proj({ uat: { setup: [{ name: 'dq', run: 'echo "$DQ_MISSING"' }] } }));
  eq('double-quoted ref still required', [dq.out.steps[0].result, dq.out.steps[0].missing], ['missing-env', ['DQ_MISSING']]);
  const sq = go(proj({ uat: { setup: [{ name: 'sq', run: "echo 'it''s' $SQ_MISSING" }] } }));
  eq('ref after adjacent quotes still required', sq.out.steps[0].missing, ['SQ_MISSING']);
}
{
  // un commento di shell non apre span tra apici e i suoi riferimenti sono ignorati
  const marker = path.join(mktmp(), 'ran');
  const cm = go(proj({ uat: { setup: [{ name: 'cm', run: "# don't forget\necho dev=$DEVICE_ID" }] } }));
  eq('apostrophe in a comment: later ref still required', [cm.out.steps[0].result, cm.out.steps[0].missing], ['missing-env', ['DEVICE_ID']]);
  const cref = go(proj({ uat: { setup: [{ name: 'cref', run: `echo hi # uses $COMMENT_ONLY\ntouch ${marker}` }] } }));
  eq('ref inside a comment is not required', [cref.out.steps[0].result, fs.existsSync(marker)], ['ran', true]);
  const mid = go(proj({ uat: { setup: [{ name: 'mid', run: 'echo a#b $HASH_MISSING' }] } }));
  eq('# not at a word start is no comment', mid.out.steps[0].missing, ['HASH_MISSING']);
  const dqh = go(proj({ uat: { setup: [{ name: 'dqh', run: 'echo "# $DQH_MISSING"' }] } }));
  eq('# inside double quotes is no comment', dqh.out.steps[0].missing, ['DQH_MISSING']);
  // quote aperta a fine testo: fail closed, ogni riferimento conta
  const open = go(proj({ uat: { setup: [{ name: 'open', run: "echo it's $OPEN_MISSING '$OPEN_QUOTED'" }] } }));
  eq('unbalanced single quote: every ref required', open.out.steps[0].missing, ['OPEN_MISSING', 'OPEN_QUOTED']);
  const openD = go(proj({ uat: { setup: [{ name: 'openD', run: "echo \"x $OPEND_MISSING '$OPEND_Q'" }] } }));
  eq('unbalanced double quote: every ref required', openD.out.steps[0].missing, ['OPEND_MISSING', 'OPEND_Q']);
}
{
  const big = parseArgs(['run', '--repo', '/x', '--step-timeout', '86401']);
  ok('parseArgs: --step-timeout above 86400 rejected', big.error);
  ok('parseArgs: --ready-timeout above 86400 rejected', parseArgs(['run', '--repo', '/x', '--ready-timeout', '86401']).error);
  ok('parseArgs: 86400 accepted', !parseArgs(['run', '--repo', '/x', '--step-timeout', '86400', '--ready-timeout', '86400']).error);
  eq('oversized timeout exits 2', run(['run', '--repo', '/x', '--ready-timeout', '999999']).code, 2);
}
{
  // a tiny fractional timeout still becomes a valid >= 1 ms spawn timeout
  const r = go(proj({ uat: { setup: [{ name: 'hang', run: 'sleep 30' }] } }), ['--step-timeout', '0.0001']);
  eq('sub-millisecond timeout: timeout result', r.out.steps[0].result, 'timeout');
}
{
  // a mid-run exception keeps the steps already collected
  const gone = mktmp();
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = gone;
  try {
    const r = go(proj({ uat: { setup: [
      { name: 'a', run: 'true', check: `rm -rf ${gone}` },
      { name: 'b', run: 'true' },
    ] } }));
    eq('mid-run exception: invalid with message', [r.out.status, typeof r.out.message], ['invalid', 'string']);
    eq('mid-run exception: collected steps kept', r.out.steps.map((s) => [s.index, s.result]), [[0, 'skipped']]);
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
  }
}
{
  // the poll after run caps each check at the remaining ready time
  const dir = mktmp();
  const t0 = Date.now();
  const r = go(proj({ uat: { setup: [{ name: 'slow', run: `touch ${dir}/ran`, check: `test -f ${dir}/ran && sleep 30` }] } }), ['--ready-timeout', '1']);
  eq('slow check while polling: not-ready', r.out.steps[0].result, 'not-ready');
  ok('poll check capped at the remaining ready time', Date.now() - t0 < 8000);
}
{
  // not-ready: the run succeeds but the check never passes
  const d = proj({ uat: { setup: [{ name: 'srv', run: 'true', check: 'false' }] } });
  const t0 = Date.now();
  const r = go(d, ['--ready-timeout', '1']);
  eq('not-ready', [r.out.status, r.out.steps[0].result], ['failed', 'not-ready']);
  ok('not-ready waited for the timeout', Date.now() - t0 >= 900);
  // ready after a delayed check
  const dir = mktmp();
  const d2 = proj({ uat: { setup: [{ name: 'srv', run: `(sleep 1; touch ${dir}/up) >/dev/null 2>&1 &`, check: `test -f ${dir}/up` }] } });
  const r2 = go(d2, ['--ready-timeout', '10']);
  eq('a backgrounded process is detected through check', [r2.out.status, r2.out.steps[0].result], ['ready', 'ran']);
}
{
  // timeouts
  const t0 = Date.now();
  const r = go(proj({ uat: { setup: [{ name: 'hang', run: 'sleep 30' }] } }), ['--step-timeout', '1']);
  eq('hung run: timeout', [r.out.status, r.out.steps[0].result], ['failed', 'timeout']);
  ok('hung run killed promptly', Date.now() - t0 < 10000);
  // a hung check counts as failing before run: the step runs
  const dir = mktmp();
  const r2 = go(proj({ uat: { setup: [{ name: 'c', run: `touch ${dir}/ran`, check: 'sleep 30' }] } }), ['--step-timeout', '1', '--ready-timeout', '1']);
  eq('hung check before run: step runs', fs.existsSync(path.join(dir, 'ran')), true);
  eq('hung check while polling: not-ready', r2.out.steps[0].result, 'not-ready');
  // a backgrounded child holding stdout must not hang the helper
  const t1 = Date.now();
  const r3 = go(proj({ uat: { setup: [{ name: 'bg', run: 'sleep 4 &' }] } }));
  eq('background child does not block', r3.out.status, 'ready');
  ok('returns before the background child ends', Date.now() - t1 < 3500);
}
{
  // output: bounded tail and redaction
  const big = go(proj({ uat: { setup: [{ name: 'big', run: 'yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 20000000; exit 1' }] } }));
  ok('large output stays bounded', big.out.steps[0].output.length <= 2100);
  const red = go(proj({ uat: {
    setup: [{ name: 'leak', run: 'echo "token=$API_TOKEN pw=$QA_PW"; exit 1' }],
    accounts: { qa: { user: 'u', secret: '$QA_PW' } },
  } }), [], { API_TOKEN: 'abc123', QA_PW: 'zzz-secret' });
  const o = red.out.steps[0].output;
  ok('output redacts referenced values to $NAME', o.includes('token=$API_TOKEN') && o.includes('pw=$QA_PW') && !o.includes('abc123') && !o.includes('zzz-secret'));
  const overlap = go(proj({ uat: { setup: [{ name: 'o', run: 'echo $SHORT $LONG; exit 1' }] } }), [], { SHORT: 'abc', LONG: 'abcdef' });
  const oo = overlap.out.steps[0].output;
  ok('overlapping values redact whole (longest first)', oo.includes('$SHORT $LONG') && !oo.includes('def'));
}

// --- end to end -----------------------------------------------------------------
{
  const d = proj({ uat: { setup: [{ name: 'a', run: 'true' }] } });
  const out = execFileSync('node', [scriptPath, 'run', '--repo', d], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: emptyHome, HOME: '/nonexistent-home' },
  }).toString();
  const parsed = JSON.parse(out.trim());
  eq('e2e: ready', parsed.status, 'ready');
  eq('e2e: one JSON line', out.trim().split('\n').length, 1);
  let code = 0;
  try { execFileSync('node', [scriptPath], { stdio: 'ignore' }); } catch (err) { code = err.status; }
  eq('e2e: usage error exits 2', code, 2);
  ok('e2e: helper is executable', (fs.statSync(scriptPath).mode & 0o111) !== 0);
}

// --- cleanup --------------------------------------------------------------------
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });

console.log(`uat-setup.test.js: ${passed} checks passed`);
