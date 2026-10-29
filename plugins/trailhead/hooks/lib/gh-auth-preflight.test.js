#!/usr/bin/env node
// Test per lib/gh-auth-preflight.js. Run: node gh-auth-preflight.test.js
// Nessun framework: assert semplici, runner iniettato (mai la rete).
const assert = require('assert');
const path = require('path');
const { check } = require(path.join(__dirname, 'gh-auth-preflight.js'));

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const AUTH_ERR = { status: 1, stdout: '{"message":"Bad credentials","status":"401"}', stderr: 'gh: Bad credentials (HTTP 401)' };
const GOOD = { status: 0, stdout: 'octo\n', stderr: '' };

// Runner che modella la precedenza di gh: GH_TOKEN, poi GITHUB_TOKEN, poi il login salvato.
// valid: { GH_TOKEN, GITHUB_TOKEN, stored } = true/false.
function model(valid, failure) {
  const calls = [];
  const run = (env) => {
    calls.push(env);
    const v = env.GH_TOKEN ? valid.GH_TOKEN : env.GITHUB_TOKEN ? valid.GITHUB_TOKEN : valid.stored;
    if (v === 'other') return failure;
    return v ? GOOD : AUTH_ERR;
  };
  run.calls = calls;
  return run;
}

// nessuna variabile token -> null, runner mai chiamato
{
  const run = model({ stored: false });
  ok('no token var: null', check({ env: { PATH: 'x' }, run }) === null);
  ok('no token var: runner not called', run.calls.length === 0);
}
// variabile vuota = non impostata
{
  const run = model({ stored: false });
  ok('empty var counts as unset', check({ env: { GH_TOKEN: '', GITHUB_TOKEN: '' }, run }) === null && run.calls.length === 0);
}
// token d'ambiente valido -> null
ok('env token works: null', check({ env: { GITHUB_TOKEN: 'good' }, run: model({ GITHUB_TOKEN: true }) }) === null);

// token rifiutato, login salvato valido -> notice (variante ii)
{
  const run = model({ GITHUB_TOKEN: false, stored: true });
  const n = check({ env: { GITHUB_TOKEN: 'bad' }, run });
  ok('rejected + stored ok: notice', typeof n === 'string' && n.includes('GITHUB_TOKEN') && n.includes('overrides the working `gh` login'));
  ok('rejected + stored ok: workaround', n.includes('GITHUB_TOKEN= gh'));
  ok('notice never has the token value', !n.includes('bad'));
  ok('stripped call used', run.calls.length === 2 && run.calls[1].GITHUB_TOKEN === '');
}
// rifiuto riconosciuto anche solo da stdout 401 o solo da stderr
for (const [label, res] of [
  ['stdout only', { status: 1, stdout: '{"status": "401"}', stderr: '' }],
  ['stderr only', { status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' }],
]) {
  const calls = [];
  const run = (env) => { calls.push(env); return env.GITHUB_TOKEN ? res : GOOD; };
  ok(`auth failure detected: ${label}`, check({ env: { GITHUB_TOKEN: 'bad' }, run }) !== null);
}
// token rifiutato e nessun login funzionante -> variante iii
{
  const n = check({ env: { GITHUB_TOKEN: 'bad' }, run: model({ GITHUB_TOKEN: false, stored: false }) });
  ok('nothing works: notice', n.includes('no working `gh` login') && n.includes('gh auth login'));
  ok('nothing works: no workaround', !n.includes('GITHUB_TOKEN= gh') && !n.includes('overrides'));
}
// errori non di auth -> null
for (const [label, res] of [
  ['network', { status: 1, stdout: '', stderr: 'error connecting to api.github.com' }],
  ['timeout', { status: null, stdout: '', stderr: '', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }],
  ['ENOENT', { status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) }],
  ['throws', null],
]) {
  const run = () => { if (res === null) throw new Error('boom'); return res; };
  ok(`non-auth failure: ${label} -> null`, check({ env: { GITHUB_TOKEN: 'bad' }, run }) === null);
}
// entrambe le variabili: GH_TOKEN rifiutato, GITHUB_TOKEN valido
{
  const n = check({ env: { GH_TOKEN: 'bad', GITHUB_TOKEN: 'good' }, run: model({ GH_TOKEN: false, GITHUB_TOKEN: true, stored: false }) });
  ok('both set: names only GH_TOKEN', n.includes('GH_TOKEN') && !n.includes('GH_TOKEN, GITHUB_TOKEN'));
  ok('both set: says GITHUB_TOKEN works', n.includes('valid GITHUB_TOKEN') && n.includes('GH_TOKEN= gh'));
}
// entrambe rifiutate, login salvato valido
{
  const n = check({ env: { GH_TOKEN: 'bad', GITHUB_TOKEN: 'bad2' }, run: model({ GH_TOKEN: false, GITHUB_TOKEN: false, stored: true }) });
  ok('both rejected: names both', n.includes('GH_TOKEN') && n.includes('GITHUB_TOKEN') && n.includes('GH_TOKEN= GITHUB_TOKEN= gh'));
  ok('both rejected: no token values', !n.includes('bad'));
}
// source
for (const source of ['resume', 'compact']) {
  const run = model({ GITHUB_TOKEN: false, stored: true });
  ok(`source ${source}: skipped`, check({ env: { GITHUB_TOKEN: 'bad' }, run, source }) === null && run.calls.length === 0);
}
for (const source of ['startup', 'clear', undefined, 'weird']) {
  const run = model({ GITHUB_TOKEN: false, stored: true });
  ok(`source ${source}: checked`, check({ env: { GITHUB_TOKEN: 'bad' }, run, source }) !== null);
}
ok('no em-dash in notices', !/—/.test(check({ env: { GITHUB_TOKEN: 'bad' }, run: model({ GITHUB_TOKEN: false, stored: true }) })));

console.log(`gh-auth-preflight: ${passed} passed`);
