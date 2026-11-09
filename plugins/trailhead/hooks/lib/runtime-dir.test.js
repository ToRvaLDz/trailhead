#!/usr/bin/env node
// Tests of templates/trailhead-runtime-dir.js (and its hooks/lib copy), #371:
// the runtime files under .trailhead/ stay out of git through the dir's own
// .gitignore, and nothing is written through a symlink leaving the project.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const T = path.join(__dirname, '..', '..', 'templates');
const { MANAGED_LINES, RuntimeDirRefused, ensureRuntimeDir, prepareRuntimeFile, main } = require(path.join(T, 'trailhead-runtime-dir.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-runtime-dir-')));
let seq = 0;
const mktmp = () => { const d = path.join(tmp, String(seq++)); fs.mkdirSync(d); return d; };
const ignoreOf = (root) => fs.readFileSync(path.join(root, '.trailhead', '.gitignore'), 'utf8');
const SEED = MANAGED_LINES.join('\n') + '\n';
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const node = (cwd, script, ...args) => spawnSync(process.execPath, [path.join(T, script), ...args], { cwd, encoding: 'utf8' });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

try {
  t('first write seeds .trailhead/.gitignore', () => {
    const root = mktmp();
    assert.strictEqual(ensureRuntimeDir(root), path.join(root, '.trailhead'));
    assert.strictEqual(ignoreOf(root), SEED);
  });

  t('seeding is idempotent', () => {
    const root = mktmp();
    ensureRuntimeDir(root);
    ensureRuntimeDir(root);
    assert.strictEqual(ignoreOf(root), SEED);
  });

  t('a user line is kept; the managed lines go on top when * is missing', () => {
    const root = mktmp();
    fs.mkdirSync(path.join(root, '.trailhead'));
    fs.writeFileSync(path.join(root, '.trailhead', '.gitignore'), '!notes.md\n');
    ensureRuntimeDir(root);
    assert.strictEqual(ignoreOf(root), SEED + '!notes.md\n');
    fs.writeFileSync(path.join(root, '.trailhead', '.gitignore'), SEED + '!notes.md\n!more\n');
    ensureRuntimeDir(root);
    assert.strictEqual(ignoreOf(root), SEED + '!notes.md\n!more\n');
  });

  t('a symlinked .trailhead pointing outside the project is refused', () => {
    const root = mktmp();
    const outside = mktmp();
    fs.symlinkSync(outside, path.join(root, '.trailhead'), 'dir');
    assert.throws(() => prepareRuntimeFile(path.join(root, '.trailhead', 'work-state.json')), RuntimeDirRefused);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  t('a symlinked .trailhead inside the project is accepted', () => {
    const root = mktmp();
    fs.mkdirSync(path.join(root, 'state'));
    fs.symlinkSync(path.join(root, 'state'), path.join(root, '.trailhead'), 'dir');
    ensureRuntimeDir(root);
    assert.strictEqual(fs.readFileSync(path.join(root, 'state', '.gitignore'), 'utf8'), SEED);
  });

  t('a runtime file symlinked outside (or dangling) is refused', () => {
    const root = mktmp();
    const outside = mktmp();
    fs.mkdirSync(path.join(root, '.trailhead'));
    fs.symlinkSync(path.join(outside, 'x'), path.join(root, '.trailhead', 'label-guard-ack'));
    assert.throws(() => prepareRuntimeFile(path.join(root, '.trailhead', 'label-guard-ack')), RuntimeDirRefused);
  });

  t('a file outside .trailhead/ only gets its dir', () => {
    const root = mktmp();
    prepareRuntimeFile(path.join(root, 'trailhead', 'model-defaults-ack'));
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'trailhead')), []);
  });

  t('CLI ensure: ok, refused, usage', () => {
    const root = mktmp();
    const out = [];
    const stdout = { write: (s) => out.push(JSON.parse(s)) };
    assert.strictEqual(main(['ensure', '--repo', root], { stdout }), 0);
    assert.deepStrictEqual(out.pop(), { status: 'ok', dir: path.join(root, '.trailhead') });
    const bad = mktmp();
    fs.symlinkSync(mktmp(), path.join(bad, '.trailhead'), 'dir');
    assert.strictEqual(main(['ensure'], { cwd: bad, stdout }), 0);
    assert.strictEqual(out.pop().status, 'refused');
    const err = process.stderr.write;
    process.stderr.write = () => true;
    try {
      assert.strictEqual(main(['ensure', '--repo'], { stdout }), 2);
      assert.strictEqual(main([], { stdout }), 2);
    } finally { process.stderr.write = err; }
  });

  t('fresh repo: helper writes leave nothing untracked, config.json stays trackable', () => {
    const root = mktmp();
    if (git(root, 'init', '-q').status !== 0) return;
    for (const [script, ...args] of [
      ['trailhead-isolation-answer.js', 'record', '--repo', '.', '--answer', 'no', '--others', 'none'],
      ['trailhead-work-state.js', 'set', '--repo', '.', '--map', '1', '--ticket', '2', '--title', 'x', '--step', 'discuss'],
      ['trailhead-runtime-dir.js', 'ensure', '--repo', '.'],
    ]) assert.strictEqual(node(root, script, ...args).status, 0, script);
    fs.writeFileSync(path.join(root, '.trailhead', 'session-ticket'), '#2 x\n');
    fs.writeFileSync(path.join(root, '.trailhead', 'tmp-body.md'), 'x');
    assert.strictEqual(git(root, 'status', '--porcelain', '--untracked-files=all').stdout, '');
    fs.writeFileSync(path.join(root, '.trailhead', 'config.json'), '{}\n');
    assert.strictEqual(git(root, 'status', '--porcelain', '--untracked-files=all').stdout, '?? .trailhead/config.json\n');
  });

  t('hooks/lib copy is byte-identical to the template', () => {
    const a = fs.readFileSync(path.join(T, 'trailhead-runtime-dir.js'));
    const b = fs.readFileSync(path.join(__dirname, 'trailhead-runtime-dir.js'));
    assert.ok(a.equals(b));
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${n} passed`);
