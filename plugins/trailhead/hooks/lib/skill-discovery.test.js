#!/usr/bin/env node
// Tests for templates/trailhead-skill-discovery.js. Run: node skill-discovery.test.js
// No framework: plain asserts. Seams (#426): source detection, timeout, decline memory,
// no download through npx, the off switch, parser + relevance.
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-skill-discovery.js');
const { main, parseResults, filterItems, stripAnsi, buildNpxEnv } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const mktmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-skill-discovery-test-')));
const SYS_PATH = '/usr/bin:/bin';

// A project root, a fake HOME and a fake bin dir; env points only at them.
function sandbox() {
  const dir = mktmp();
  const root = path.join(dir, 'proj');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  for (const d of [root, home, bin]) fs.mkdirSync(d, { recursive: true });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), PATH: bin };
  return { dir, root, home, bin, env };
}

function fakeBin(bin, name, body) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };

// Runs main() capturing stdout; awaits a Promise result (find). Returns { code, line, err }.
async function run(argv, opts = {}) {
  const chunks = [];
  const errChunks = [];
  const code = await main(argv, { stdout: { write: (s) => chunks.push(s) }, stderr: { write: (s) => errChunks.push(s) }, ...opts });
  const line = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
  return { code, line, err: errChunks.join('') };
}

const REAL_OUTPUT = [
  'Install with npx skills add <owner/repo@skill>',
  '',
  'github/awesome-copilot@github-issues 18K installs',
  '└ https://skills.sh/github/awesome-copilot/github-issues',
  '',
  'github/awesome-copilot@gh-cli 21.2K installs',
  '└ https://skills.sh/github/awesome-copilot/gh-cli',
  '',
].join('\n');

const printScript = (text) => `cat <<'EOF'\n${text}\nEOF`;

(async () => {
  // --- parser + relevance ------------------------------------------------------
  {
    const items = parseResults(REAL_OUTPUT);
    ok('parser finds both blocks', items.length === 2);
    ok('parser id', items[0].id === 'github/awesome-copilot@github-issues' && items[1].id === 'github/awesome-copilot@gh-cli');
    ok('parser installs K', items[0].installs === 18000 && items[1].installs === 21200);
    ok('parser url', items[0].url === 'https://skills.sh/github/awesome-copilot/github-issues');
    const other = parseResults('a/b@c 9.5K installs\n└ https://x/y\n\nd/e@f 1.2M installs\n\ng/h@i 773 installs\n└ https://z');
    ok('parser 9.5K, 1.2M and plain integer', other[0].installs === 9500 && other[1].installs === 1200000 && other[2].installs === 773);
    ok('parser tolerates a missing url line', other[1].url === null);
    const ansi = REAL_OUTPUT.replace(/(github\/awesome-copilot@\S+)/g, '\u001b[1m$1\u001b[0m').replace(/(\d+K installs)/g, '\u001b[90m$1\u001b[39m').replace(/└/g, '\u001b[90m└\u001b[39m');
    ok('stripAnsi removes codes', stripAnsi(ansi) === REAL_OUTPUT);
    ok('parser identical with ANSI codes', JSON.stringify(parseResults(ansi)) === JSON.stringify(items));

    const ranked = filterItems(items, 'github issues', [], 5);
    ok('relevance keeps both, higher overlap first', ranked.length === 2 && ranked[0].name === 'github-issues');
    const one = filterItems(items, 'terraform modules', [], 5);
    ok('irrelevant matches dropped', one.length === 0);
    ok('stopwords and short tokens do not count', filterItems(items, 'the of a to in', [], 5).length === 0 && filterItems(items, 'the gh', [], 5).length === 0);
    ok('limit caps', filterItems(items, 'github', [], 1).length === 1);
    ok('ties ranked by installs', filterItems(items, 'github', [], 5)[0].name === 'gh-cli');
    ok('declined id dropped', filterItems(items, 'github', [items[1].id], 5).every((x) => x.id !== items[1].id));
  }

  // --- source detection ----------------------------------------------------------
  {
    const s = sandbox();
    const base = ['sources', '--repo', s.root];
    const r0 = await run(base, { env: s.env });
    ok('nothing installed: no sources', r0.code === 0 && r0.line.status === 'ok' && r0.line.sources.length === 0);
    const r1 = await run([...base, '--host-search', 'yes'], { env: s.env });
    ok('host only with --host-search yes', JSON.stringify(r1.line.sources) === '[{"name":"host"}]');
    const r2 = await run([...base, '--host-search', 'no'], { env: s.env });
    ok('--host-search no lists no host', r2.line.sources.length === 0);

    fakeBin(s.bin, 'skills', 'exit 0');
    const r3 = await run([...base, '--host-search', 'yes'], { env: s.env });
    ok('order: host then cli', JSON.stringify(r3.line.sources) === '[{"name":"host"},{"name":"cli","kind":"binary"}]');
    const r4 = await run(base, { env: s.env });
    ok('cli binary without host', JSON.stringify(r4.line.sources) === '[{"name":"cli","kind":"binary"}]');

    // find-skills present: cli through npx (needs npx on PATH and npm >= 7)
    const t = sandbox();
    fs.mkdirSync(path.join(t.root, '.agents', 'skills', 'find-skills'), { recursive: true });
    const noNpx = await run(base.map((x) => (x === s.root ? t.root : x)), { env: t.env, npmMajor: () => 10 });
    ok('find-skills without npx on PATH: no cli', noNpx.line.sources.length === 0);
    fakeBin(t.bin, 'npx', 'exit 0');
    const viaNpx = await run(['sources', '--repo', t.root], { env: t.env, npmMajor: () => 10 });
    ok('find-skills + npm >= 7: cli npx-cache', JSON.stringify(viaNpx.line.sources) === '[{"name":"cli","kind":"npx-cache"}]');
    const oldNpm = await run(['sources', '--repo', t.root], { env: t.env, npmMajor: () => 6 });
    ok('npm < 7: no cli', oldNpm.line.sources.length === 0);
    const noNpm = await run(['sources', '--repo', t.root], { env: t.env, npmMajor: () => null });
    ok('npm unknown: no cli', noNpm.line.sources.length === 0);

    // every known skills dir counts; an unrelated skill does not
    for (const rel of [['.claude', 'skills'], ['.agents', 'skills']]) {
      const u = sandbox();
      fakeBin(u.bin, 'npx', 'exit 0');
      fs.mkdirSync(path.join(u.home, ...rel, 'other-skill'), { recursive: true });
      const none = await run(['sources', '--repo', u.root], { env: u.env, npmMajor: () => 10 });
      ok(`unrelated skill in ~/${rel[0]} is not find-skills`, none.line.sources.length === 0);
      fs.mkdirSync(path.join(u.home, ...rel, 'find-skills'), { recursive: true });
      const some = await run(['sources', '--repo', u.root], { env: u.env, npmMajor: () => 10 });
      ok(`find-skills in ~/${rel[0]} counts`, some.line.sources.length === 1);
    }
    const c = sandbox();
    fakeBin(c.bin, 'npx', 'exit 0');
    fs.mkdirSync(path.join(c.home, '.codex', 'skills', 'find-skills'), { recursive: true });
    ok('find-skills in the Codex home counts', (await run(['sources', '--repo', c.root], { env: c.env, npmMajor: () => 10 })).line.sources.length === 1);

    const bad = await run(['sources', '--repo', s.root, '--host-search', 'maybe'], { env: s.env });
    ok('bad --host-search is a usage error', bad.code === 2);
  }

  // --- off switch + precedence -----------------------------------------------------
  {
    const s = sandbox();
    const marker = path.join(s.dir, 'spawned');
    s.env.PATH = `${s.bin}:${SYS_PATH}`;
    fakeBin(s.bin, 'skills', `echo x > ${marker}\n${printScript(REAL_OUTPUT)}`);
    const globalCfg = path.join(s.env.CLAUDE_CONFIG_DIR, 'trailhead', 'config.json');
    const projCfg = path.join(s.root, '.trailhead', 'config.json');

    writeJson(projCfg, { 'skills.search': 'off' });
    const off = await run(['sources', '--repo', s.root, '--host-search', 'yes'], { env: s.env });
    ok('off: sources prints only status off', JSON.stringify(off.line) === '{"status":"off"}');
    const offFind = await run(['find', '--repo', s.root, '--query', 'github issues'], { env: s.env });
    ok('off: find has no matches', JSON.stringify(offFind.line) === '{"status":"off","matches":[]}');
    ok('off: nothing spawned', !fs.existsSync(marker));
    writeJson(path.join(s.dir, 'items.json'), [{ id: 'a/b@github', name: 'github' }]);
    const offFilter = await run(['filter', '--repo', s.root, '--query', 'github', '--file', path.join(s.dir, 'items.json')], { env: s.env });
    ok('off: filter has no matches', offFilter.line.status === 'off' && offFilter.line.matches.length === 0);

    writeJson(projCfg, { skills: { search: 'auto' } });
    writeJson(globalCfg, { 'skills.search': 'off' });
    const projWins = await run(['sources', '--repo', s.root], { env: s.env });
    ok('project auto (nested) wins over global off', projWins.line.status === 'ok' && projWins.line.sources.length === 1);

    fs.rmSync(projCfg);
    const globalOff = await run(['sources', '--repo', s.root], { env: s.env });
    ok('global off applies without project key', globalOff.line.status === 'off');

    writeJson(projCfg, { 'skills.search': 'bogus' });
    const invalid = await run(['sources', '--repo', s.root], { env: s.env });
    ok('invalid project value warns and falls to global', invalid.line.status === 'off' && invalid.line.warnings.length === 1);
    fs.rmSync(globalCfg);
    const dflt = await run(['sources', '--repo', s.root], { env: s.env });
    ok('default is auto', dflt.line.status === 'ok' && dflt.line.warnings.length === 1);
    writeJson(projCfg, '{ not json');
    ok('corrupt config falls to the default', (await run(['sources', '--repo', s.root], { env: s.env })).line.status === 'ok');
  }

  // --- find: happy path, no cli, failure ----------------------------------------------
  {
    const s = sandbox();
    const none = await run(['find', '--repo', s.root, '--query', 'github issues'], { env: s.env });
    ok('no cli: silent skip', JSON.stringify(none.line) === '{"status":"ok","matches":[],"skipped":"no-cli"}' && none.code === 0);

    s.env.PATH = `${s.bin}:${SYS_PATH}`;
    fakeBin(s.bin, 'skills', `[ "$1" = find ] && [ "$2" = "github issues" ] || exit 9\n${printScript(REAL_OUTPUT)}`);
    const found = await run(['find', '--repo', s.root, '--query', 'github issues'], { env: s.env });
    ok('find returns ranked matches', found.line.matches.length === 2 && found.line.matches[0].name === 'github-issues' && !('skipped' in found.line));
    const lim = await run(['find', '--repo', s.root, '--query', 'github issues', '--limit', '1'], { env: s.env });
    ok('find honours --limit', lim.line.matches.length === 1);

    fakeBin(s.bin, 'skills', 'echo boom >&2\nexit 3');
    const failed = await run(['find', '--repo', s.root, '--query', 'github issues'], { env: s.env });
    ok('failed search is a silent skip', failed.code === 0 && failed.line.skipped === 'failed' && failed.line.matches.length === 0);
    const noQuery = await run(['find', '--repo', s.root], { env: s.env });
    ok('missing --query is a usage error', noQuery.code === 2);
  }

  // --- timeout: bound, group kill ------------------------------------------------------
  {
    const s = sandbox();
    const pidFile = path.join(s.dir, 'child.pid');
    fakeBin(s.bin, 'skills', `sleep 30 &\necho $! > ${pidFile}\nsleep 30`);
    s.env.PATH = `${s.bin}:${SYS_PATH}`;
    const started = Date.now();
    const r = await run(['find', '--repo', s.root, '--query', 'github issues', '--timeout', '1'], { env: s.env, graceMs: 200 });
    const took = Date.now() - started;
    ok('timeout: returns within the bound', took < 4000);
    ok('timeout: empty skipped result', r.code === 0 && JSON.stringify(r.line) === '{"status":"ok","matches":[],"skipped":"timeout"}');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; }
    }
    ok('timeout: the surviving child of the group is dead', !alive);

    // a child that ignores SIGTERM is still ended (SIGKILL after the grace)
    const pidFile2 = path.join(s.dir, 'child2.pid');
    fakeBin(s.bin, 'skills', `trap '' TERM\n(trap '' TERM; sleep 30) &\necho $! > ${pidFile2}\nwhile :; do sleep 1; done`);
    const t0 = Date.now();
    const r2 = await run(['find', '--repo', s.root, '--query', 'github issues', '--timeout', '1'], { env: s.env, graceMs: 300 });
    ok('timeout: SIGTERM-proof child bounded by the grace', Date.now() - t0 < 5000 && r2.line.skipped === 'timeout');
    const pid2 = Number(fs.readFileSync(pidFile2, 'utf8'));
    let alive2 = true;
    for (let i = 0; i < 20 && alive2; i++) {
      try { process.kill(pid2, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive2 = false; }
    }
    ok('timeout: SIGTERM-proof grandchild is dead', !alive2);
  }

  // --- decline memory ------------------------------------------------------------------
  {
    const s = sandbox();
    fakeBin(s.bin, 'skills', printScript(REAL_OUTPUT));
    s.env.PATH = `${s.bin}:${SYS_PATH}`;
    const idA = 'github/awesome-copilot@github-issues';
    const idB = 'github/awesome-copilot@gh-cli';
    const file = path.join(s.root, '.trailhead', 'skills-declined.json');

    const d1 = await run(['decline', '--repo', s.root, '--id', idA], { env: s.env });
    ok('decline writes the record', d1.line.status === 'declined' && JSON.parse(fs.readFileSync(file, 'utf8')).declined[0] === idA);
    ok('decline seeds .trailhead/.gitignore', fs.existsSync(path.join(s.root, '.trailhead', '.gitignore')));
    const f1 = await run(['find', '--repo', s.root, '--query', 'github issues'], { env: s.env });
    ok('declined id is not proposed again (find)', f1.line.matches.every((m) => m.id !== idA) && f1.line.matches.length === 1);

    await run(['decline', '--repo', s.root, '--id', idB], { env: s.env });
    const list = await run(['declined', '--repo', s.root], { env: s.env });
    ok('two sequential declines keep both ids', list.line.declined.length === 2 && list.line.declined.includes(idA) && list.line.declined.includes(idB));
    await run(['decline', '--repo', s.root, '--id', idA], { env: s.env });
    ok('declining twice does not duplicate', (await run(['declined', '--repo', s.root], { env: s.env })).line.declined.length === 2);
    ok('no temp file left behind', fs.readdirSync(path.join(s.root, '.trailhead')).every((f) => !f.endsWith('.tmp')));

    const itemsFile = path.join(s.dir, 'host.json');
    writeJson(itemsFile, [{ id: idA, name: 'github-issues' }, { id: 'x/y@github-actions', name: 'github-actions', description: 'CI' }, { id: 'p/q@pdf', name: 'pdf' }]);
    const flt = await run(['filter', '--repo', s.root, '--query', 'github actions', '--file', itemsFile], { env: s.env });
    ok('filter drops declined and irrelevant host results', flt.line.matches.length === 1 && flt.line.matches[0].id === 'x/y@github-actions');
    const badFile = await run(['filter', '--repo', s.root, '--query', 'x1y2', '--file', path.join(s.dir, 'missing.json')], { env: s.env });
    ok('filter with an unreadable file is skipped, exit 0', badFile.code === 0 && badFile.line.status === 'skipped' && badFile.line.matches.length === 0);

    // a corrupt record reads as empty, never a crash
    fs.writeFileSync(file, '{ corrupt');
    const afterCorrupt = await run(['find', '--repo', s.root, '--query', 'github issues'], { env: s.env });
    ok('corrupt record reads as empty', afterCorrupt.code === 0 && afterCorrupt.line.matches.length === 2);
    fs.writeFileSync(file, '{"declined": "nope"}');
    ok('wrong-shape record reads as empty', (await run(['declined', '--repo', s.root], { env: s.env })).line.declined.length === 0);
    const d3 = await run(['decline', '--repo', s.root, '--id', idB], { env: s.env });
    ok('decline over a corrupt record recovers', d3.line.status === 'declined' && d3.line.declined.length === 1);

    // a failing rename is reported as skipped and leaves no temp
    const failFs = { ...fs, renameSync: () => { throw new Error('EXDEV simulated'); } };
    const s2 = sandbox();
    const rf = await run(['decline', '--repo', s2.root, '--id', idA], { env: s2.env, fs: failFs });
    ok('failing rename is skipped, exit 0', rf.code === 0 && rf.line.status === 'skipped' && /EXDEV/.test(rf.line.message));
    ok('failing rename leaves no temp or record', fs.readdirSync(path.join(s2.root, '.trailhead')).every((f) => f === '.gitignore'));

    // an unsafe .trailhead symlink is refused
    const s3 = sandbox();
    const outside = path.join(s3.dir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(s3.root, '.trailhead'));
    const rs = await run(['decline', '--repo', s3.root, '--id', idA], { env: s3.env });
    ok('unsafe .trailhead symlink is skipped', rs.code === 0 && rs.line.status === 'skipped');
    ok('nothing written through the symlink', fs.readdirSync(outside).length === 0);

    const noId = await run(['decline', '--repo', s.root], { env: s.env });
    ok('decline without --id is a usage error', noId.code === 2);
  }

  // --- worktree canonicalisation: the record lives in the main checkout -----------------
  {
    const s = sandbox();
    const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (git(['init', '-q'], s.root).status === 0) {
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], s.root);
      const wt = path.join(s.dir, 'wt');
      if (git(['worktree', 'add', '-q', '-b', 'trailhead/t1', wt], s.root).status === 0) {
        await run(['decline', '--repo', wt, '--id', 'a/b@c'], { env: s.env });
        ok('decline from a linked worktree lands in the main checkout', fs.existsSync(path.join(s.root, '.trailhead', 'skills-declined.json')) && !fs.existsSync(path.join(wt, '.trailhead', 'skills-declined.json')));
      }
    }
  }

  // --- end to end through the real script ------------------------------------------------
  {
    const s = sandbox();
    fakeBin(s.bin, 'skills', printScript(REAL_OUTPUT));
    const r = spawnSync(process.execPath, [scriptPath, 'find', '--repo', s.root, '--query', 'github issues'], { env: { ...s.env, PATH: `${s.bin}:${SYS_PATH}` }, encoding: 'utf8' });
    ok('e2e find exit 0 with JSON', r.status === 0 && JSON.parse(r.stdout).matches.length === 2);
    const u = spawnSync(process.execPath, [scriptPath, 'bogus'], { encoding: 'utf8' });
    ok('e2e usage error exits 2', u.status === 2 && /usage/.test(u.stderr));
  }

  // --- no download through npx -------------------------------------------------------------
  if (spawnSync('npx', ['--version'], { encoding: 'utf8' }).status !== 0) {
    console.log('skip: npx not available, no-download seam not exercised');
  } else {
    const dir = mktmp();
    const cache = path.join(dir, 'cache');
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(cache);
    fs.mkdirSync(cwd);
    let connections = 0;
    const server = net.createServer((sock) => { connections++; sock.destroy(); });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const env = buildNpxEnv({ ...process.env, npm_config_cache: cache, npm_config_registry: `http://127.0.0.1:${server.address().port}/` });
    ok('env builder forces offline', env.npm_config_offline === 'true');
    const pkg = `trailhead-nonexistent-pkg-${Math.random().toString(36).slice(2, 10)}`;
    const started = Date.now();
    const code = await new Promise((res) => {
      const child = spawn('npx', ['--no', pkg, 'find', 'x'], { cwd, env, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); res('timeout'); }, 60000);
      child.on('exit', (c) => { clearTimeout(timer); res(c); });
    });
    await new Promise((res) => server.close(res));
    ok('npx --no of an uncached package fails within the bound', typeof code === 'number' && code !== 0 && Date.now() - started < 60000);
    ok('npx made zero registry connections', connections === 0);
    ok('npx left nothing in the _npx cache', !fs.existsSync(path.join(cache, '_npx')) || fs.readdirSync(path.join(cache, '_npx')).every((h) => !fs.existsSync(path.join(cache, '_npx', h, 'node_modules', pkg))));
    ok('npx created no node_modules in the cwd', !fs.existsSync(path.join(cwd, 'node_modules')));
  }

  console.log(`skill-discovery.test.js: ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
