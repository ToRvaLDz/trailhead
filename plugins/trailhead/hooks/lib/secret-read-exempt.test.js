#!/usr/bin/env node
// Test di lib/secret-read-exempt.js (#376): validazione delle voci, lettura del config e
// ogni condizione git/fs di isExemptPath, su repo git veri in directory temporanee.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./secret-read-exempt.js');

const NAME = '.env.local';
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, name); passed++; };

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=x@x', '-c', 'user.name=x', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
function mkRepo(config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sre-')));
  roots.push(dir);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, NAME), 'K=v\n');
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.trailhead'));
    fs.writeFileSync(path.join(dir, '.trailhead', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  git(dir, 'add', '--', NAME);
  git(dir, 'commit', '-q', '-m', 'x');
  return dir;
}

// --- normaliseEntry ---
eq('plain entry', lib.normaliseEntry(NAME), NAME);
eq('./ prefix dropped', lib.normaliseEntry(`./${NAME}`), NAME);
eq('nested with doubled slashes', lib.normaliseEntry(`./a//b/${NAME}`), `a/b/${NAME}`);
for (const bad of ['', '   ', '.', './', '/abs/x', '../x', 'a/../x', 'a/*', 'a?', 'a[b]', '.git/x', 'a/.GIT/x', 'a\\b', 5, null, undefined, {}, []]) {
  ok(`invalid entry ${JSON.stringify(bad)}`, lib.normaliseEntry(bad) === null);
}

// --- loadExemptEntries ---
eq('no config file', lib.loadExemptEntries(mkRepo()), []);
eq('nested key', lib.loadExemptEntries(mkRepo({ secretRead: { exempt: [NAME] } })), [NAME]);
eq('flat key', lib.loadExemptEntries(mkRepo({ 'secretRead.exempt': [`./${NAME}`] })), [NAME]);
eq('nested wins over flat', lib.loadExemptEntries(mkRepo({ secretRead: { exempt: ['a'] }, 'secretRead.exempt': ['b'] })), ['a']);
eq('invalid entries dropped', lib.loadExemptEntries(mkRepo({ secretRead: { exempt: ['../x', NAME, 3] } })), [NAME]);
eq('non-array value', lib.loadExemptEntries(mkRepo({ secretRead: { exempt: NAME } })), []);
eq('bad JSON', lib.loadExemptEntries(mkRepo('{ nope')), []);
eq('null top', lib.loadExemptEntries(null), []);

// --- gitTop ---
{
  const d = mkRepo();
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  eq('gitTop from a subdirectory', lib.gitTop(path.join(d, 'a', 'b')), d);
  ok('gitTop outside a repo is null', lib.gitTop(path.parse(d).root) === null || lib.gitTop(path.parse(d).root) === path.parse(d).root);
}

// --- isExemptPath: una condizione alla volta ---
{
  const d = mkRepo();
  const abs = path.join(d, NAME);
  ok('clean tracked file is exempt', lib.isExemptPath(abs, d, [NAME]));
  ok('empty entries -> not exempt', !lib.isExemptPath(abs, d, []));
  ok('entry for another path -> not exempt', !lib.isExemptPath(abs, d, ['other']));
  ok('path outside the top -> not exempt', !lib.isExemptPath(path.join(path.dirname(d), NAME), d, [NAME]));
  ok('the top itself -> not exempt', !lib.isExemptPath(d, d, [NAME]));
  ok('missing args -> not exempt', !lib.isExemptPath(undefined, d, [NAME]) && !lib.isExemptPath(abs, null, [NAME]));

  fs.writeFileSync(abs, 'K=changed\n');
  ok('modified working tree -> not exempt', !lib.isExemptPath(abs, d, [NAME]));
  git(d, 'checkout', '--', NAME);
  ok('restored -> exempt again', lib.isExemptPath(abs, d, [NAME]));

  fs.writeFileSync(abs, 'K=staged\n');
  git(d, 'add', '--', NAME);
  ok('staged change not committed -> not exempt', !lib.isExemptPath(abs, d, [NAME]));
  git(d, 'commit', '-q', '-m', 'y');
  ok('committed -> exempt', lib.isExemptPath(abs, d, [NAME]));

  fs.writeFileSync(path.join(d, '.gitignore'), `${NAME}\n`);
  ok('tracked but matching .gitignore -> not exempt', !lib.isExemptPath(abs, d, [NAME]));
  fs.rmSync(path.join(d, '.gitignore'));

  fs.rmSync(abs);
  ok('deleted from the working tree -> not exempt', !lib.isExemptPath(abs, d, [NAME]));
  fs.symlinkSync('elsewhere', abs);
  ok('replaced by a symlink -> not exempt', !lib.isExemptPath(abs, d, [NAME]));
}

// il top dietro un symlink (cwd lessicale) resta esente
{
  const d = mkRepo();
  const alias = `${d}-alias`;
  roots.push(alias);
  fs.symlinkSync(d, alias);
  ok('top reached through a symlinked ancestor path is exempt', lib.isExemptPath(path.join(alias, NAME), alias, [NAME]));
  ok('isExemptFor resolves config and top from the cwd', lib.isExemptFor(path.join(d, NAME), d) === false); // senza config
  fs.mkdirSync(path.join(d, '.trailhead'));
  fs.writeFileSync(path.join(d, '.trailhead', 'config.json'), JSON.stringify({ secretRead: { exempt: [NAME] } }));
  ok('isExemptFor true once configured', lib.isExemptFor(path.join(d, NAME), d));
  ok('isExemptFor false for a cwd outside a repo', !lib.isExemptFor(path.join(d, NAME), '/'));
}

console.log(`✓ secret-read-exempt lib: ${passed} assertions passed`);
