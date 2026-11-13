#!/usr/bin/env node
// Test per l'esenzione `secretRead.exempt` del secret-read guard (#376).
// Run: node trailhead-secret-read-exempt.test.js
// Repo git veri in directory temporanee (nessun mock di git); l'hook gira come processo,
// con il `cwd` nel payload come lo manda il runtime.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectSecretRead } = require('./trailhead-secret-read-guard.js');

const HOOK = path.join(__dirname, 'trailhead-secret-read-guard.js');
const NAME = '.env.local';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=x@x', '-c', 'user.name=x', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });

// Repo con `files` ({rel: contenuto}) tracciati e committati, `config` scritto in
// .trailhead/config.json (oggetto, o stringa grezza per un JSON rotto). `extra` e' una
// funzione che ritocca il repo dopo il commit.
function mkRepo({ files = { [NAME]: 'KEY=placeholder\n' }, config, extra, track = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'srx-')));
  roots.push(dir);
  git(dir, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.trailhead'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.trailhead', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  if (track) {
    git(dir, 'add', '--', ...Object.keys(files));
    git(dir, 'commit', '-q', '-m', 'x');
  }
  if (extra) extra(dir);
  return dir;
}

function runHook(toolName, toolInput, cwd, env) {
  const payload = { tool_name: toolName, tool_input: toolInput };
  if (cwd !== undefined) payload.cwd = cwd;
  try {
    const out = execFileSync('node', [HOOK], { input: JSON.stringify(payload), env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString() };
  }
}
const bash = (command, cwd, env) => runHook('Bash', { command }, cwd, env);
const read = (file_path, cwd) => runHook('Read', { file_path }, cwd);
const allowed = (r) => r.code === 0;
const blocked = (r) => r.code === 2;

const NESTED = { secretRead: { exempt: [NAME] } };

// --- il caso base: placeholder tracciato e configurato ---
{
  const d = mkRepo({ config: NESTED });
  ok('Bash cat <name> allowed for a configured tracked file', allowed(bash(`cat ${NAME}`, d)));
  ok('Bash cat ./<name> allowed', allowed(bash(`cat ./${NAME}`, d)));
  ok('Bash cat < <name> allowed', allowed(bash(`cat < ${NAME}`, d)));
  ok('Bash cat absolute path allowed', allowed(bash(`cat ${path.join(d, NAME)}`, d)));
  ok('Read relative allowed', allowed(read(NAME, d)));
  ok('Read absolute allowed', allowed(read(path.join(d, NAME), d)));
  ok('pure seam: ctx.cwd lets the Read through', detectSecretRead('Read', { file_path: NAME }, { cwd: d }) === null);
  ok('pure seam: without ctx the same Read is a hit', !!detectSecretRead('Read', { file_path: NAME }));
  ok('Bash with a second, non-exempt secret still blocks', blocked(bash(`cat ${NAME} .env.production`, d)));
  ok('Bash with a non-exempt secret first still blocks', blocked(bash(`cat .env.production ${NAME}`, d)));
  ok('a different, untracked secret name still blocks', blocked(bash('cat .env.production', d)));
  ok('Bash cat after a pipe still allowed', allowed(bash(`cat ${NAME} | head -1`, d)));
  ok('the block reason names the key', /secretRead\.exempt/.test(bash('cat .env.production', d).out));

  // sottodirectory: cwd diverso dal top, solo percorsi assoluti
  const sub = path.join(d, 'sub');
  fs.mkdirSync(sub);
  ok('Read absolute from a subdirectory allowed', allowed(read(path.join(d, NAME), sub)));
  ok('Bash absolute operand from a subdirectory allowed', allowed(bash(`cat ${path.join(d, NAME)}`, sub)));
  ok('a relative operand from a subdirectory is not the configured path', blocked(bash(`cat ${NAME}`, sub)));
  ok('Read of a `..` path stays blocked', blocked(read(`../${NAME}`, sub)));
  ok('Bash operand with a `..` segment stays blocked', blocked(bash(`cat ../${NAME}`, sub)));
}

// --- forme che restano bloccate ---
{
  const d = mkRepo({ config: NESTED });
  fs.mkdirSync(path.join(d, 'sub'));
  for (const command of [
    `cd sub && cat ${NAME}`,
    `cd . && cat ${NAME}`,
    `pushd sub; cat ${NAME}`,
    `(cd sub; cat ${NAME})`,
    `cat "$PWD/${NAME}"`,
    `cat $HOME/${NAME}`,
    `cat ~/${NAME}`,
    `cat "${NAME}"`,
    `cat '${NAME}'`,
    `cat .env.loc*`,
    `cat \\${NAME}`,
    `git show HEAD:${NAME}`,
    `bash -c "cat ${NAME}"`,
    `echo $(cat ${NAME})`,
    `echo "$(cat ${NAME})"`,
    `cat <<EOF\n$(cat ${NAME})\nEOF`,
    `grep KEY ${NAME}`,
    `env -C sub cat ${NAME}`,
    `nice cat ${NAME}`,
    `FOO=1 cat ${NAME}`,
    `source ${NAME}`,
  ]) {
    ok(`stays blocked: ${command.replace(/\n/g, '\\n')}`, blocked(bash(command, d)));
  }
  ok('a cd later in the command does not affect an earlier read', allowed(bash(`cat ${NAME}; cd sub`, d)));
}

// --- senza configurazione: invariato ---
{
  const none = mkRepo({});
  ok('no config -> blocked (Bash)', blocked(bash(`cat ${NAME}`, none)));
  ok('no config -> blocked (Read)', blocked(read(NAME, none)));
  ok('.env.example passes without config', allowed(bash('cat .env.example', none)));
  ok('.env.example Read passes without config', allowed(read('.env.example', none)));
  for (const [label, config] of [
    ['empty list', { secretRead: { exempt: [] } }],
    ['non-array', { secretRead: { exempt: NAME } }],
    ['object value', { secretRead: { exempt: { a: NAME } } }],
    ['bad JSON', '{ not json'],
    ['array root', [NAME]],
    ['other key only', { isolation: { copy: [NAME] } }],
  ]) {
    const d = mkRepo({ config });
    ok(`${label} -> blocked`, blocked(bash(`cat ${NAME}`, d)));
  }
  const d = mkRepo({ config: NESTED });
  ok('no cwd in the payload -> blocked', blocked(bash(`cat ${NAME}`, undefined)));
  ok('cwd outside any git repo -> blocked', blocked(bash(`cat ${NAME}`, fs.realpathSync(os.tmpdir()))));
  ok('cwd of a missing dir -> blocked', blocked(bash(`cat ${NAME}`, path.join(d, 'nope', 'deeper'))));
}

// --- chiave piatta e annidata ---
{
  const flat = mkRepo({ config: { 'secretRead.exempt': [NAME] } });
  ok('flat key works', allowed(bash(`cat ${NAME}`, flat)));
  const both = mkRepo({ config: { secretRead: { exempt: [] }, 'secretRead.exempt': [NAME] } });
  ok('nested wins over flat when both exist', blocked(bash(`cat ${NAME}`, both)));
  const norm = mkRepo({ config: { secretRead: { exempt: [`./${NAME}`] } } });
  ok('a ./ prefix on the entry is normalised', allowed(bash(`cat ${NAME}`, norm)));
  const nestedDir = mkRepo({ files: { [`app/${NAME}`]: 'K=v\n' }, config: { secretRead: { exempt: [`./app//${NAME}`] } } });
  ok('a nested entry works with doubled slashes', allowed(read(`app/${NAME}`, nestedDir)));
  ok('the root file is not exempt by a nested entry', blocked(read(NAME, nestedDir)));
}

// --- voci non valide ignorate ---
{
  for (const entry of [path.join('/', 'abs', NAME), `../${NAME}`, `a/../${NAME}`, '.env.*', '.env.loca?', '.env.loca[l]', `.git/${NAME}`, `sub\\${NAME}`, '', '  ', 5, null, {}]) {
    const d = mkRepo({ config: { secretRead: { exempt: [entry] } } });
    ok(`invalid entry ${JSON.stringify(entry)} grants nothing`, blocked(bash(`cat ${NAME}`, d)));
  }
  const d = mkRepo({ config: { secretRead: { exempt: [`../${NAME}`, 7, NAME] } } });
  ok('an invalid entry is skipped, a valid one next to it still works', allowed(bash(`cat ${NAME}`, d)));
  const abs = mkRepo({});
  fs.mkdirSync(path.join(abs, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(abs, '.trailhead', 'config.json'), JSON.stringify({ secretRead: { exempt: [path.join(abs, NAME)] } }));
  ok('an absolute entry equal to the real path grants nothing', blocked(bash(`cat ${NAME}`, abs)));
}

// --- le condizioni git/fs ---
{
  const untracked = mkRepo({ config: NESTED, track: false });
  ok('untracked -> blocked', blocked(bash(`cat ${NAME}`, untracked)));

  const added = mkRepo({ config: NESTED, track: false, extra: (d) => git(d, 'add', '--', NAME) });
  ok('staged but never committed -> blocked (the commit is the reviewed content)', blocked(bash(`cat ${NAME}`, added)));

  const missing = mkRepo({ files: { README: 'x' }, config: NESTED });
  ok('configured but absent -> blocked (nothing to exempt)', blocked(bash(`cat ${NAME}`, missing)));

  const tracked = mkRepo({ files: { 'real.txt': 'KEY=placeholder\n' }, config: NESTED, track: false, extra: (d) => {
    fs.symlinkSync('real.txt', path.join(d, NAME));
    git(d, 'add', '--', 'real.txt', NAME);
    git(d, 'commit', '-q', '-m', 'x');
  } });
  ok('tracked as a symlink (120000) -> blocked', blocked(bash(`cat ${NAME}`, tracked)));
  ok('tracked as a symlink (120000) -> blocked (Read)', blocked(read(NAME, tracked)));

  const swapped = mkRepo({ config: NESTED, extra: (d) => {
    fs.writeFileSync(path.join(d, 'other.txt'), 'x');
    fs.rmSync(path.join(d, NAME));
    fs.symlinkSync('other.txt', path.join(d, NAME));
  } });
  ok('index says 100644 but the working tree is a symlink -> blocked', blocked(bash(`cat ${NAME}`, swapped)));

  const linkedParent = mkRepo({ files: { [`dir/${NAME}`]: 'K=v\n' }, config: { secretRead: { exempt: [`dir/${NAME}`] } }, extra: (d) => {
    fs.renameSync(path.join(d, 'dir'), path.join(d, 'dir2'));
    fs.symlinkSync('dir2', path.join(d, 'dir'));
  } });
  ok('symlinked parent directory -> blocked', blocked(read(`dir/${NAME}`, linkedParent)));
  ok('symlinked parent directory -> blocked (Bash)', blocked(bash(`cat dir/${NAME}`, linkedParent)));

  const ignored = mkRepo({ files: { [NAME]: 'K=v\n' }, config: NESTED, track: false, extra: (d) => {
    fs.writeFileSync(path.join(d, '.gitignore'), `${NAME}\n`);
    git(d, 'add', '-f', '--', NAME);
    git(d, 'commit', '-q', '-m', 'x');
  } });
  ok('tracked but gitignored -> blocked', blocked(bash(`cat ${NAME}`, ignored)));

  const modified = mkRepo({ config: NESTED, extra: (d) => fs.writeFileSync(path.join(d, NAME), 'KEY=real-secret\n') });
  ok('modified content -> blocked', blocked(bash(`cat ${NAME}`, modified)));
  ok('modified content -> blocked (Read)', blocked(read(NAME, modified)));

  const exec = mkRepo({ config: NESTED, extra: (d) => { fs.chmodSync(path.join(d, NAME), 0o755); git(d, 'add', '--', NAME); git(d, 'commit', '-q', '-m', 'x'); } });
  ok('tracked as 100755 -> allowed', allowed(bash(`cat ${NAME}`, exec)));

  // un repo senza commit ma con il file nell'indice e' coperto sopra; un worktree collegato
  const main = mkRepo({ config: NESTED });
  const wt = path.join(path.dirname(main), `${path.basename(main)}-wt`);
  roots.push(wt);
  git(main, 'worktree', 'add', '-q', '--detach', wt);
  ok('a linked worktree (.git is a file) works', allowed(bash(`cat ${NAME}`, wt)));
}

// --- nessuna chiamata a git se non serve ---
{
  const d = mkRepo({ config: NESTED });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'srx-bin-'));
  roots.push(bin);
  const log = path.join(bin, 'calls.log');
  const real = execFileSync('which', ['git']).toString().trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho call >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);

  bash('cat README.md', d, env);
  ok('a non-secret operand makes no git call', calls() === 0);
  bash('cat .env.production', d, env);
  ok('a secret operand that matches no entry makes no git call', calls() === 0);
  const un = mkRepo({});
  bash(`cat ${NAME}`, un, env);
  ok('an unconfigured project makes no git call', calls() === 0);
  ok('the configured match does call git and is allowed', allowed(bash(`cat ${NAME}`, d, env)) && calls() > 0);
}

console.log(`✓ secret-read-exempt: ${passed} assertions passed`);
