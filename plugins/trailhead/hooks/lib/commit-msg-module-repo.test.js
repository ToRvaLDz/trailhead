#!/usr/bin/env node
// Regression for #257: the git commit-msg hook must work in a repo whose root
// package.json says "type": "module". The hook is installed by the sync script
// into a fixture repo and exercised through real `git commit` calls.
// Run: node commit-msg-module-repo.test.js
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const syncScript = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-commit-msg-sync.js');

// Prefisso della riga che il wrapper stampa quando non può applicare le regole (#262).
const INACTIVE = 'trailhead: commit-msg hook inactive (';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

function gitEnv(extra) {
  return Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Trailhead Test',
    GIT_AUTHOR_EMAIL: 'trailhead-test@example.com',
    GIT_COMMITTER_NAME: 'Trailhead Test',
    GIT_COMMITTER_EMAIL: 'trailhead-test@example.com',
  }, extra || {});
}

// Repo fixture: package.json "type": "module" alla radice, hook installato dallo
// script di sync, marker session-ticket = #1.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-commit-msg-esm-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const out = execFileSync(process.execPath, [syncScript, '--repo', dir], { env: gitEnv(), encoding: 'utf8' });
  assert.strictEqual(JSON.parse(out).status, 'installed');
  fs.mkdirSync(path.join(dir, '.trailhead'));
  fs.writeFileSync(path.join(dir, '.trailhead', 'session-ticket'), '#1 x\n');
  return { dir, hooksDir: path.join(dir, '.git', 'hooks') };
}

function commit(dir, message) {
  const r = spawnSync('git', ['commit', '--allow-empty', '-q', '-m', message], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr || '' };
}

// (a) commit convenzionale con Refs: #1 passa
{
  const { dir } = makeRepo();
  const r = commit(dir, 'fix: thing\n\nRefs: #1');
  ok('module repo: conventional commit with Refs passes', r.status === 0);
  ok('module repo: clean commit stays silent', !r.stderr.includes('trailhead:'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// (b) senza trailer: rifiutato col messaggio di trailhead
{
  const { dir } = makeRepo();
  const r = commit(dir, 'fix: thing');
  ok('module repo: missing Refs is rejected with exit 1', r.status === 1);
  ok('module repo: rejection carries trailhead message', r.stderr.includes('trailhead:') && r.stderr.includes('Refs: #1'));
  ok('module repo: no ESM load error leaks', !r.stderr.includes('require is not defined'));
  ok('module repo: a violation carries no inactive notice', !r.stderr.includes(INACTIVE));
  fs.rmSync(dir, { recursive: true, force: true });
}

// (c) errori di avvio: mai bloccare un commit, ma segnalarlo su stderr (#262)
{
  const { dir, hooksDir } = makeRepo();
  fs.rmSync(path.join(hooksDir, 'trailhead-commit-msg.cjs'));
  const r = commit(dir, 'not conventional at all');
  ok('module repo: missing .cjs lets the commit through', r.status === 0);
  ok('module repo: missing .cjs prints the inactive notice',
    r.stderr.includes(INACTIVE + 'trailhead-commit-msg.cjs missing or unreadable)'));
  fs.rmSync(dir, { recursive: true, force: true });
}
// .cjs presente ma illeggibile: da root chmod non toglie la lettura, quindi si salta.
if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  const { dir, hooksDir } = makeRepo();
  fs.chmodSync(path.join(hooksDir, 'trailhead-commit-msg.cjs'), 0o000);
  const r = commit(dir, 'not conventional at all');
  ok('module repo: unreadable .cjs lets the commit through', r.status === 0);
  ok('module repo: unreadable .cjs prints the inactive notice',
    r.stderr.includes(INACTIVE + 'trailhead-commit-msg.cjs missing or unreadable)'));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const { dir, hooksDir } = makeRepo();
  fs.writeFileSync(path.join(hooksDir, 'trailhead-commit-msg.cjs'), "throw new Error('boom at load');\n");
  const r = commit(dir, 'not conventional at all');
  ok('module repo: .cjs crashing at load lets the commit through', r.status === 0);
  ok('module repo: .cjs crashing at load prints the inactive notice',
    r.stderr.includes(INACTIVE + 'trailhead-commit-msg.cjs failed to run, exit '));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // node assente dal PATH: il wrapper deve uscire 0 anche con un messaggio che
  // altrimenti sarebbe una violazione (controllo negativo con PATH normale).
  const { dir, hooksDir } = makeRepo();
  const msgFile = path.join(dir, 'MSG');
  fs.writeFileSync(msgFile, 'not conventional at all\n');
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-empty-bin-'));
  const hook = path.join(hooksDir, 'commit-msg');
  const withNode = spawnSync('/bin/sh', [hook, msgFile], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
  ok('wrapper control: violation exits 1 with node on PATH', withNode.status === 1);
  const noNode = spawnSync('/bin/sh', [hook, msgFile], { cwd: dir, env: { PATH: emptyBin }, encoding: 'utf8' });
  ok('wrapper: node absent from PATH exits 0', noNode.status === 0);
  ok('wrapper: node absent from PATH prints the inactive notice',
    (noNode.stderr || '').includes(INACTIVE + 'node not found on PATH)'));
  fs.rmSync(emptyBin, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`✓ commit-msg module repo (#257): ${passed} assertions passed`);
