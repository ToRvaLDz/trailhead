#!/usr/bin/env node
// Tests for gh-subcommand.js. Run: node gh-subcommand.test.js
const assert = require('assert');
const { parseGhSubcommand } = require('./gh-subcommand.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- env prefix + gh binary detection ---
ok('env prefix before gh is skipped',
  (() => { const r = parseGhSubcommand('FOO=1 gh issue edit'); return r && r.sub === 'issue' && r.verb === 'edit'; })());
ok('an absolute gh path is recognised',
  (() => { const r = parseGhSubcommand('/usr/bin/gh api repos/o/r/issues/5'); return r && r.sub === 'api'; })());
ok('a non-gh command returns null', parseGhSubcommand('echo issue edit') === null);
ok('a bare gh with no subcommand does not throw', (() => {
  const r = parseGhSubcommand('gh');
  return r && r.sub === undefined && r.verb === undefined;
})());

// --- plain subcommand/verb ---
ok('plain gh issue edit', (() => { const r = parseGhSubcommand('gh issue edit 5'); return r.sub === 'issue' && r.verb === 'edit'; })());
ok('plain gh pr edit', (() => { const r = parseGhSubcommand('gh pr edit'); return r.sub === 'pr' && r.verb === 'edit'; })());
ok('plain gh api', (() => { const r = parseGhSubcommand('gh api repos/o/r/issues/5'); return r.sub === 'api'; })());

// --- -R / --repo two-token form still resolves ---
ok('gh -R owner/repo issue edit 5 resolves issue/edit',
  (() => { const r = parseGhSubcommand('gh -R owner/repo issue edit 5'); return r.sub === 'issue' && r.verb === 'edit'; })());
ok('gh --repo owner/repo pr edit resolves pr/edit',
  (() => { const r = parseGhSubcommand('gh --repo owner/repo pr edit'); return r.sub === 'pr' && r.verb === 'edit'; })());

// --- --repo=owner/repo single-token form ---
ok('gh --repo=owner/repo issue edit resolves issue/edit',
  (() => { const r = parseGhSubcommand('gh --repo=owner/repo issue edit'); return r.sub === 'issue' && r.verb === 'edit'; })());

// --- REGRESSION (#153): an unknown two-token global flag no longer desyncs ---
ok('gh --hostname h issue edit 5 --body "" resolves issue/edit',
  (() => { const r = parseGhSubcommand('gh --hostname h issue edit 5 --body ""'); return r.sub === 'issue' && r.verb === 'edit'; })());
ok('gh --hostname h pr edit 5 resolves pr/edit',
  (() => { const r = parseGhSubcommand('gh --hostname h pr edit 5'); return r.sub === 'pr' && r.verb === 'edit'; })());
ok('gh --hostname h api --method PATCH ... resolves api',
  (() => {
    const r = parseGhSubcommand('gh --hostname h api --method PATCH repos/o/r/issues/5 -f body=x');
    return r.sub === 'api';
  })());

// --- multiple unknown two-token flags ---
ok('gh --hostname h --foo bar issue edit 5 resolves issue/edit',
  (() => { const r = parseGhSubcommand('gh --hostname h --foo bar issue edit 5'); return r.sub === 'issue' && r.verb === 'edit'; })());

// --- a boolean flag directly before the subcommand is not over-consumed ---
ok('gh --foo issue edit 5 resolves issue/edit (boolean flag not swallowing the subcommand)',
  (() => { const r = parseGhSubcommand('gh --foo issue edit 5'); return r.sub === 'issue' && r.verb === 'edit'; })());

// --- single-token --hostname=h form ---
ok('gh --hostname=h issue edit resolves issue/edit',
  (() => { const r = parseGhSubcommand('gh --hostname=h issue edit'); return r.sub === 'issue' && r.verb === 'edit'; })());

console.log(`✓ gh-subcommand: ${passed} assertions passed`);
