#!/usr/bin/env node
// Tests for templates/trailhead-isolation-copy.js. Run: node isolation-copy.test.js
// No framework: plain asserts, same style as work-state.test.js.
//
// Layers covered:
//   1. Pure helpers: checkRelPath(), readCopyList().
//   2. main() with injected cwd/env/stdout against mkdtemp folders (real git).
//   3. End-to-end: execFileSync of the script itself, global config via CLAUDE_CONFIG_DIR.
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-isolation-copy.js');
const { checkRelPath, readCopyList, parseArgs, main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-isolation-copy-test-'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// A main checkout with .gitignore, a tracked .env.example, and the given config.
function mkRepo(config, { files = {} } = {}) {
  const dir = mktmp();
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.npmrc\nconfig/local.json\nsecrets/\n');
  fs.writeFileSync(path.join(dir, '.env.example'), 'A=\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.gitignore', '.env.example', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.trailhead'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.trailhead', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

function run(argv, { env = {}, fsMod } = {}) {
  const chunks = [];
  const errChunks = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errChunks.push(String(s)); return true; };
  let code;
  try {
    code = main(argv, { cwd: '/', env: { HOME: '/nonexistent-home', ...env }, stdout: { write: (s) => chunks.push(s) }, ...(fsMod ? { fs: fsMod } : {}) });
  } finally {
    process.stderr.write = realErr;
  }
  const lines = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code, out: lines[0], lines, err: errChunks.join('') };
}

const emptyHome = mktmp(); // CLAUDE_CONFIG_DIR with no global config
const envNoGlobal = { CLAUDE_CONFIG_DIR: emptyHome };

// --- checkRelPath ------------------------------------------------------------
ok('plain file ok', checkRelPath('.env') === null);
ok('nested ok', checkRelPath('config/local.json') === null);
ok('absolute rejected', checkRelPath('/etc/passwd') !== null);
ok('.. rejected', checkRelPath('../x') !== null);
ok('inner .. rejected', checkRelPath('a/../../x') !== null);
ok('.git rejected', checkRelPath('.git') !== null);
ok('nested .git rejected', checkRelPath('a/.git/config') !== null);
ok('.gitignore is not a .git segment', checkRelPath('.gitignore') === null);

// --- readCopyList ------------------------------------------------------------
{
  const d = mktmp();
  const file = path.join(d, 'config.json');
  const read = () => readCopyList(file, fs);
  ok('absent file -> unset', read().state === 'unset');
  fs.writeFileSync(file, '{"other":1}');
  ok('no key -> unset', read().state === 'unset');
  fs.writeFileSync(file, '{"isolation":{"copy":[".env"]}}');
  ok('nested list', read().list.join() === '.env');
  fs.writeFileSync(file, '{"isolation.copy":[".npmrc"]}');
  ok('flat list', read().list.join() === '.npmrc');
  fs.writeFileSync(file, '{"isolation":{"copy":[".env"]},"isolation.copy":[".npmrc"]}');
  const both = read();
  ok('nested wins over flat', both.list.join() === '.env');
  ok('both shapes warn', both.warnings.length === 1 && /nested/.test(both.warnings[0]));
  fs.writeFileSync(file, '{"isolation":{"copy":[]}}');
  ok('empty list is set', read().state === 'set' && read().list.length === 0);
  fs.writeFileSync(file, '{bad');
  ok('bad JSON invalid', read().state === 'invalid' && read().message.length > 0);
  fs.writeFileSync(file, '{"isolation":{"copy":".env"}}');
  ok('non-array invalid', read().state === 'invalid');
  fs.writeFileSync(file, '{"isolation":{"copy":[".env",3]}}');
  ok('non-string entry invalid', read().state === 'invalid');
  fs.writeFileSync(file, '{"isolation":{"copy":[""]}}');
  ok('empty entry invalid', read().state === 'invalid');
}

// --- usage -------------------------------------------------------------------
ok('parseArgs unknown flag', parseArgs(['--bogus']).error !== undefined);
{
  const r = run(['--from', '/tmp'], { env: envNoGlobal });
  ok('missing --to is exit 2', r.code === 2 && r.lines.length === 0);
  ok('unknown flag is exit 2', run(['--from', 'a', '--to', 'b', '--x'], { env: envNoGlobal }).code === 2);
}

// --- copy file + directory, present, missing ---------------------------------
{
  const from = mkRepo({ isolation: { copy: ['.env', 'secrets', 'config/local.json', 'nope.txt'] } },
    { files: { '.env': 'SECRET=1\n', 'secrets/a.key': 'k', 'config/local.json': '{}', 'secrets/.git/HEAD': 'ref', 'secrets/sub/b.key': 'b' } });
  const to = mktmp();
  fs.writeFileSync(path.join(to, '.env'), 'EXISTING\n');
  const r = run(['--from', from, '--to', to], { env: envNoGlobal });
  ok('exit 0', r.code === 0);
  ok('status copied', r.out.status === 'copied');
  ok('copied list', r.out.copied.slice().sort().join() === 'config/local.json,secrets');
  ok('present list', r.out.present.join() === '.env');
  ok('missing list', r.out.missing.join() === 'nope.txt');
  ok('existing not overwritten', fs.readFileSync(path.join(to, '.env'), 'utf8') === 'EXISTING\n');
  ok('dest parent created', fs.readFileSync(path.join(to, 'config', 'local.json'), 'utf8') === '{}');
  ok('dir copied recursively', fs.readFileSync(path.join(to, 'secrets', 'sub', 'b.key'), 'utf8') === 'b');
  ok('nested .git skipped', !fs.existsSync(path.join(to, 'secrets', '.git')));
  ok('no suggestions when set', r.out.suggestions.length === 0);
  // Second run: everything now present.
  const r2 = run(['--from', from, '--to', to], { env: envNoGlobal });
  ok('second run nothing', r2.out.status === 'nothing' && r2.out.copied.length === 0 && r2.out.present.length === 3);
}

// --- empty list and rejections -----------------------------------------------
{
  const from = mkRepo({ isolation: { copy: [] } });
  const r = run(['--from', from, '--to', mktmp()], { env: envNoGlobal });
  ok('empty list nothing', r.out.status === 'nothing' && r.out.suggestions.length === 0);
}
{
  const from = mkRepo({ isolation: { copy: ['/etc/passwd', '../x', '.git/config', 'a/.git/x', '.env'] } }, { files: { '.env': 'e' } });
  const to = mktmp();
  const r = run(['--from', from, '--to', to], { env: envNoGlobal });
  ok('rejected 4', r.out.rejected.length === 4);
  ok('valid entry still copied', r.out.copied.join() === '.env');
}

// --- symlink safety ----------------------------------------------------------
{
  // Source ancestor symlink escape: link -> outside dir, entry link/secret.
  const outside = mktmp();
  fs.writeFileSync(path.join(outside, 'secret'), 'top');
  const from = mkRepo({ isolation: { copy: ['link/secret'] } });
  fs.symlinkSync(outside, path.join(from, 'link'));
  const to = mktmp();
  const r = run(['--from', from, '--to', to], { env: envNoGlobal });
  ok('source ancestor symlink rejected', r.out.rejected.join() === 'link/secret' && r.out.copied.length === 0);
  ok('nothing written for source escape', !fs.existsSync(path.join(to, 'link')));
}
{
  // Destination ancestor symlink escape.
  const outside = mktmp();
  const from = mkRepo({ isolation: { copy: ['d/.env'] } }, { files: { 'd/.env': 'x' } });
  const to = mktmp();
  fs.symlinkSync(outside, path.join(to, 'd'));
  const r = run(['--from', from, '--to', to], { env: envNoGlobal });
  ok('destination ancestor symlink rejected', r.out.rejected.join() === 'd/.env');
  ok('nothing written outside', fs.readdirSync(outside).length === 0);
}
{
  // Final symlink copied as a symlink, never followed.
  const outside = mktmp();
  fs.writeFileSync(path.join(outside, 'target'), 'private');
  const from = mkRepo({ isolation: { copy: ['.env'] } });
  fs.symlinkSync(path.join(outside, 'target'), path.join(from, '.env'));
  const to = mktmp();
  const r = run(['--from', from, '--to', to], { env: envNoGlobal });
  ok('final symlink copied', r.out.copied.join() === '.env');
  ok('final symlink stays a symlink', fs.lstatSync(path.join(to, '.env')).isSymbolicLink());
  ok('symlink verbatim', fs.readlinkSync(path.join(to, '.env')) === path.join(outside, 'target'));
}
{
  // Nested symlink in a copied directory is verbatim.
  const outside = mktmp();
  const from = mkRepo({ isolation: { copy: ['secrets'] } }, { files: { 'secrets/a': 'a' } });
  fs.symlinkSync(outside, path.join(from, 'secrets', 'ln'));
  const to = mktmp();
  run(['--from', from, '--to', to], { env: envNoGlobal });
  ok('nested symlink verbatim', fs.lstatSync(path.join(to, 'secrets', 'ln')).isSymbolicLink() &&
    fs.readlinkSync(path.join(to, 'secrets', 'ln')) === outside);
}

// --- invalid config: nothing copied, no hint ---------------------------------
for (const [label, cfg] of [['bad JSON', '{oops'], ['non-array', { isolation: { copy: '.env' } }], ['bad entry', { isolation: { copy: ['.env', 5] } }]]) {
  const from = mkRepo(cfg, { files: { '.env': 'e' } });
  const to = mktmp();
  const r = run(['--from', from, '--to', to], { env: envNoGlobal });
  ok(`${label}: invalid`, r.code === 0 && r.out.status === 'invalid' && r.out.message.length > 0);
  ok(`${label}: nothing copied, no suggestions`, r.out.copied.length === 0 && r.out.suggestions.length === 0 && !fs.existsSync(path.join(to, '.env')));
}

// --- precedence warning in output --------------------------------------------
{
  const from = mkRepo({ isolation: { copy: ['.env'] }, 'isolation.copy': ['.npmrc'] }, { files: { '.env': 'e', '.npmrc': 'n' } });
  const r = run(['--from', from, '--to', mktmp()], { env: envNoGlobal });
  ok('nested wins end to end', r.out.copied.join() === '.env' && r.out.warnings.length === 1);
}
{
  const from = mkRepo({ 'isolation.copy': ['.env'] }, { files: { '.env': 'e' } });
  const r = run(['--from', from, '--to', mktmp()], { env: envNoGlobal });
  ok('flat shape works', r.out.copied.join() === '.env' && r.out.warnings.length === 0);
}

// --- unset + hint -------------------------------------------------------------
{
  const from = mkRepo(undefined, { files: { '.env': 'e' } });
  const r = run(['--from', from, '--to', mktmp()], { env: envNoGlobal });
  ok('unset status', r.out.status === 'unset');
  ok('ignored sibling suggested', r.out.suggestions.join() === '.env');
}
{
  // Sibling absent -> not suggested; tracked sibling -> not suggested; .sample + nested.
  const from = mkRepo(undefined);
  fs.mkdirSync(path.join(from, 'config'));
  fs.writeFileSync(path.join(from, 'config', 'local.json.sample'), '{}');
  fs.writeFileSync(path.join(from, 'config', 'local.json'), '{}');
  fs.writeFileSync(path.join(from, 'tracked.json.example'), '{}');
  fs.writeFileSync(path.join(from, 'tracked.json'), '{}');
  git(from, 'add', 'config/local.json.sample', 'tracked.json.example', 'tracked.json');
  git(from, 'commit', '-q', '-m', 'more');
  const r = run(['--from', from, '--to', mktmp()], { env: envNoGlobal });
  ok('nested .sample suggested', r.out.suggestions.join() === 'config/local.json');
}
{
  // Untracked example is ignored (tracked examples only).
  const from = mkRepo(undefined, { files: { '.npmrc': 'n', '.npmrc.example': 'n' } });
  const r = run(['--from', from, '--to', mktmp()], { env: envNoGlobal });
  ok('untracked example not used', r.out.status === 'unset' && r.out.suggestions.length === 0);
}
{
  // Not a git repo: suggestions empty, no error.
  const from = mktmp();
  const r = run(['--from', from, '--to', mktmp()], { env: envNoGlobal });
  ok('git failure -> empty suggestions', r.code === 0 && r.out.status === 'unset' && r.out.suggestions.length === 0);
}
{
  const r = run(['--from', path.join(mktmp(), 'gone'), '--to', mktmp()], { env: envNoGlobal });
  ok('missing --from dir is skipped', r.code === 0 && ['skipped', 'unset'].includes(r.out.status));
}

// --- a failed copy leaves no partial destination ------------------------------
{
  const from = mkRepo({ isolation: { copy: ['secrets'] } }, { files: { 'secrets/a': 'a', 'secrets/b': 'b' } });
  const to = mktmp();
  const failing = {
    ...fs,
    cpSync: (src, dst) => { fs.mkdirSync(dst); fs.writeFileSync(path.join(dst, 'a'), 'a'); throw new Error('boom'); },
  };
  const r = run(['--from', from, '--to', to], { env: envNoGlobal, fsMod: failing });
  ok('failed copy not reported copied', r.out.copied.length === 0 && r.out.status === 'nothing');
  ok('failed copy warns', r.out.warnings.some((w) => /secrets/.test(w) && /boom/.test(w)));
  ok('partial destination removed', !fs.existsSync(path.join(to, 'secrets')));
  const r2 = run(['--from', from, '--to', to], { env: envNoGlobal });
  ok('retry copies it', r2.out.status === 'copied' && fs.existsSync(path.join(to, 'secrets', 'b')));
  // Cleanup failure adds a warning.
  const to2 = mktmp();
  const stuck = { ...failing, rmSync: () => { throw new Error('nope'); } };
  const r3 = run(['--from', from, '--to', to2], { env: envNoGlobal, fsMod: stuck });
  ok('cleanup failure warns', r3.out.warnings.some((w) => /clean/.test(w)));
}

// --- end to end with a fake CLAUDE_CONFIG_DIR ---------------------------------
{
  const cfgDir = mktmp();
  fs.mkdirSync(path.join(cfgDir, 'trailhead'));
  fs.writeFileSync(path.join(cfgDir, 'trailhead', 'config.json'), JSON.stringify({ isolation: { copy: ['.npmrc'] } }));
  const exe = (from, to) => JSON.parse(execFileSync(process.execPath, [scriptPath, '--from', from, '--to', to],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir } }).toString());

  // Global inherited when the project has no isolation.copy.
  const a = mkRepo({ other: true }, { files: { '.npmrc': 'n', '.env': 'e' } });
  const toA = mktmp();
  const ra = exe(a, toA);
  ok('e2e global inherited', ra.status === 'copied' && ra.copied.join() === '.npmrc');

  // Project value (even []) replaces global wholesale.
  const b = mkRepo({ isolation: { copy: ['.env'] } }, { files: { '.npmrc': 'n', '.env': 'e' } });
  const rb = exe(b, mktmp());
  ok('e2e project replaces global', rb.copied.join() === '.env');
  const c = mkRepo({ isolation: { copy: [] } }, { files: { '.npmrc': 'n' } });
  const rc = exe(c, mktmp());
  ok('e2e empty project list replaces global', rc.status === 'nothing');

  // Usage error is exit 2.
  const bad = spawnSync(process.execPath, [scriptPath, '--from', a], { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir } });
  ok('e2e usage exit 2', bad.status === 2);
  ok('script is executable', (fs.statSync(scriptPath).mode & 0o111) !== 0);
}

console.log(`isolation-copy.test.js: ${passed} checks passed`);
