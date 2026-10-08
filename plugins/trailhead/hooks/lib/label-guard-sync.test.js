#!/usr/bin/env node
// Tests for templates/trailhead-label-guard.yml and
// templates/trailhead-label-guard-sync.js. Run: node label-guard-sync.test.js
// No framework: plain asserts, mirrors the style of commit-msg-sync.test.js.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const templatesDir = path.resolve(__dirname, '..', '..', 'templates');
const scriptPath = path.join(templatesDir, 'trailhead-label-guard-sync.js');
const templatePath = path.join(templatesDir, 'trailhead-label-guard.yml');
const oldFixturePath = path.join(__dirname, 'fixtures', 'label-guard-0.12.0.yml');
const repoGuardPath = path.resolve(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'trailhead-label-guard.yml');

const {
  isTrailheadGuard, jobGuardIf, hasJobLevelFilter, classify, syncLabelGuard, parseArgs, GUARD_REL,
} = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const templateText = fs.readFileSync(templatePath, 'utf8');
const oldText = fs.readFileSync(oldFixturePath, 'utf8');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-label-guard-sync-test-'));
}
function writeGuard(repoDir, text) {
  const file = path.join(repoDir, GUARD_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// --- il template filtra a livello di job (i job saltati non sono fatturati) ---
const cond = jobGuardIf(templateText);
ok('template: jobs.guard has a job-level if', cond !== null);
ok('template: job-level if filters on the trailhead: prefix',
  cond.includes("startsWith(github.event.label.name, 'trailhead:')"));
ok('template: job-level if skips the repository owner',
  cond.includes('github.event.sender.login != github.repository_owner'));
ok('template: job-level if skips allowlisted logins',
  cond.includes("!contains(format(',{0},', vars.TRAILHEAD_LABEL_ALLOWLIST), format(',{0},', github.event.sender.login))"));
ok('template: the job-level if sits before runs-on',
  templateText.indexOf('    if: >-') < templateText.indexOf('    runs-on: ubuntu-latest'));
ok('template: the in-script permission check is kept',
  templateText.includes('getCollaboratorPermissionLevel') && templateText.includes("if (!label.startsWith('trailhead:')) return;"));
ok("template: the repo's own guard is byte-identical to the template",
  fs.readFileSync(repoGuardPath, 'utf8') === templateText);

// --- riconoscimento e classificazione ----------------------------------------
ok('isTrailheadGuard: template recognised', isTrailheadGuard(templateText));
ok('isTrailheadGuard: 0.12.0 guard recognised', isTrailheadGuard(oldText));
ok('isTrailheadGuard: foreign workflow rejected', !isTrailheadGuard('name: ci\non: push\n'));
ok('jobGuardIf: 0.12.0 guard has no job-level if', jobGuardIf(oldText) === null);
ok('jobGuardIf: a step-level if does not count',
  jobGuardIf('jobs:\n  guard:\n    runs-on: x\n    steps:\n      - if: startsWith(github.event.label.name, \'trailhead:\')\n') === null);
ok('jobGuardIf: an if on another job does not count',
  jobGuardIf("jobs:\n  guard:\n    runs-on: x\n  other:\n    if: startsWith(github.event.label.name, 'trailhead:')\n") === null);
ok('hasJobLevelFilter: single-line if accepted',
  hasJobLevelFilter("jobs:\n  guard:\n    if: startsWith(github.event.label.name, 'trailhead:')\n    runs-on: x\n"));

ok('classify: missing file -> absent', classify({ existingText: null, templateText }) === 'absent');
ok('classify: template -> current', classify({ existingText: templateText, templateText }) === 'current');
ok('classify: CRLF template -> current', classify({ existingText: templateText.replace(/\n/g, '\r\n'), templateText }) === 'current');
ok('classify: 0.12.0 guard -> outdated', classify({ existingText: oldText, templateText }) === 'outdated');
ok('classify: filtered but edited -> custom',
  classify({ existingText: templateText + '# local tweak\n', templateText }) === 'custom');
ok('classify: foreign workflow -> foreign', classify({ existingText: 'name: x\n', templateText }) === 'foreign');

// --- syncLabelGuard: check-only non scrive, --apply migra --------------------
{
  const repo = mktmp();
  const file = writeGuard(repo, oldText);
  const r = syncLabelGuard({ repoDir: repo, templateText });
  ok('sync check: outdated reported', r.status === 'outdated' && r.file === file);
  ok('sync check: file untouched', fs.readFileSync(file, 'utf8') === oldText);
  const a = syncLabelGuard({ repoDir: repo, templateText, apply: true });
  ok('sync apply: outdated -> upgraded', a.status === 'upgraded');
  ok('sync apply: file now equals the template', fs.readFileSync(file, 'utf8') === templateText);
  ok('sync apply: no temp file left', fs.readdirSync(path.dirname(file)).length === 1);
  ok('sync apply: second run -> current', syncLabelGuard({ repoDir: repo, templateText, apply: true }).status === 'current');
}
{
  const repo = mktmp();
  const a = syncLabelGuard({ repoDir: repo, templateText, apply: true });
  ok('sync apply: absent -> installed', a.status === 'installed' && fs.readFileSync(a.file, 'utf8') === templateText);
}
for (const [label, text] of [['custom', templateText + '# local\n'], ['foreign', 'name: x\n']]) {
  const repo = mktmp();
  const file = writeGuard(repo, text);
  const a = syncLabelGuard({ repoDir: repo, templateText, apply: true });
  ok(`sync apply: ${label} left untouched`, a.status === label && fs.readFileSync(file, 'utf8') === text);
}

// --- CLI ---------------------------------------------------------------------
ok('parseArgs: --repo needs a value', Boolean(parseArgs(['--repo']).error));
ok('parseArgs: unknown flag rejected', Boolean(parseArgs(['--nope']).error));
{
  const repo = mktmp();
  writeGuard(repo, oldText);
  const out = JSON.parse(execFileSync('node', [scriptPath, '--repo', repo], { encoding: 'utf8' }));
  ok('cli: outdated reported as JSON', out.status === 'outdated');
  const applied = JSON.parse(execFileSync('node', [scriptPath, '--repo', repo, '--apply'], { encoding: 'utf8' }));
  ok('cli: --apply upgrades', applied.status === 'upgraded');
}

console.log(`label-guard-sync: ${passed} passed`);
