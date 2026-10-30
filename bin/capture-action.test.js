#!/usr/bin/env node
// Test for #334: the composite Action actions/capture is a thin wrapper over the capture
// helper. Checks the input/output mirror, injection safety, the run block against a stub
// helper, and the docs. Plain asserts, no framework, no YAML dependency.
// Run: node bin/capture-action.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const actionPath = path.join(root, 'actions', 'capture', 'action.yml');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, name); passed++; };
const EMDASH = String.fromCharCode(0x2014);

const yml = fs.readFileSync(actionPath, 'utf8');
const lines = yml.split('\n');

// Top-level keys under a section (2-space indented names) of the minimal YAML.
function sectionKeys(name) {
  const i = lines.findIndex((l) => l === `${name}:`);
  ok(`action.yml has a ${name}: section`, i >= 0);
  const keys = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j] !== '' && !lines[j].startsWith(' ')) break;
    const m = /^ {2}([A-Za-z0-9_-]+):/.exec(lines[j]);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// Mirror
eq('inputs mirror the helper flags plus token',
  sectionKeys('inputs').sort(),
  ['body', 'body-file', 'dedupe-key', 'map', 'no-dashboard', 'of', 'repo', 'title', 'token', 'trigger', 'type', 'unverified']);
eq('outputs are issue, url, status', sectionKeys('outputs').sort(), ['issue', 'status', 'url']);
for (const name of ['issue', 'url', 'status']) {
  ok(`output ${name} reads the capture step`, yml.includes(`value: \${{ steps.capture.outputs.${name} }}`));
}
ok('composite action', /^ {2}using: composite$/m.test(yml));
ok('the step has id: capture', /^ {4}- id: capture$/m.test(yml));
ok('description notes issues: write', /issues: write/.test(yml.split('\ninputs:')[0]));
ok('branding present', /^branding:/m.test(yml));

// Extract the literal run block (fixed indentation: `run: |` then 8-space lines).
const runIdx = lines.findIndex((l) => /^ {6}run: \|$/.test(l));
assert.ok(runIdx >= 0, 'run: | literal block not found in action.yml');
const runLines = [];
for (let j = runIdx + 1; j < lines.length; j++) {
  if (lines[j] === '') { runLines.push(''); continue; }
  if (!lines[j].startsWith('        ')) break;
  runLines.push(lines[j].slice(8));
}
const script = runLines.join('\n');
ok('run block is non-empty', script.trim().length > 0);

// Injection safety
ok('no ${{ expression inside the run script', !script.includes('${{'));
ok('inputs reach the script through env:', /^ {6}env:$/m.test(yml) && /INPUT_BODY: \$\{\{ inputs\.body \}\}/.test(yml));

// Runtime against a stub helper
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-action-'));
const actionDir = path.join(tmp, 'actions', 'capture');
const tplDir = path.join(tmp, 'plugins', 'trailhead', 'templates');
fs.mkdirSync(actionDir, { recursive: true });
fs.mkdirSync(tplDir, { recursive: true });
fs.writeFileSync(path.join(tmp, 'run.sh'), script);
fs.writeFileSync(path.join(tplDir, 'trailhead-capture.js'), `
const fs = require('fs');
fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify({ argv: process.argv.slice(2), token: process.env.GH_TOKEN || null }));
if (process.env.STUB_RAW !== undefined) process.stdout.write(process.env.STUB_RAW);
else console.log(process.env.STUB_JSON || '{"status":"created","issue":7,"url":"https://github.com/o/r/issues/7"}');
process.exit(Number(process.env.STUB_EXIT || 0));
`);

const baseInputs = { INPUT_TYPE: 'bug', INPUT_TITLE: 'T', INPUT_REPO: 'o/r', INPUT_TOKEN: 'tok' };
function run(inputs, stub = {}) {
  const out = path.join(tmp, 'output.txt');
  const argvFile = path.join(tmp, 'argv.json');
  fs.rmSync(out, { force: true });
  fs.rmSync(argvFile, { force: true });
  const env = {
    PATH: process.env.PATH,
    GITHUB_ACTION_PATH: actionDir,
    GITHUB_OUTPUT: out,
    STUB_ARGV_FILE: argvFile,
    GH_TOKEN: inputs.INPUT_TOKEN || '',
    ...inputs,
    ...stub,
  };
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', path.join(tmp, 'run.sh')], { env, encoding: 'utf8' });
  const outputs = {};
  if (fs.existsSync(out)) {
    for (const l of fs.readFileSync(out, 'utf8').split('\n')) {
      const m = /^([a-z]+)=(.*)$/.exec(l);
      if (m) outputs[m[1]] = m[2];
    }
  }
  const seen = fs.existsSync(argvFile) ? JSON.parse(fs.readFileSync(argvFile, 'utf8')) : null;
  return { status: r.status, outputs, seen, stderr: r.stderr };
}

let r = run(baseInputs);
eq('minimal argv: empty optionals omitted', r.seen.argv, ['--type', 'bug', '--title', 'T', '--repo', 'o/r']);
eq('exit 0 on created', r.status, 0);
eq('outputs from the JSON line', r.outputs, { issue: '7', url: 'https://github.com/o/r/issues/7', status: 'created' });
eq('GH_TOKEN reaches the helper', r.seen.token, 'tok');

r = run({ ...baseInputs, INPUT_BODY: 'a\nb "c" $HOME\n', INPUT_BODY_FILE: 'f.md', INPUT_MAP: '5', INPUT_OF: '9', INPUT_TRIGGER: 'x y',
  INPUT_UNVERIFIED: 'true', INPUT_DEDUPE_KEY: 'k1', INPUT_NO_DASHBOARD: 'true' });
eq('full argv maps 1:1, multi-line body intact, booleans bare',
  r.seen.argv,
  ['--type', 'bug', '--title', 'T', '--body', 'a\nb "c" $HOME\n', '--body-file', 'f.md', '--repo', 'o/r', '--map', '5', '--of', '9',
    '--trigger', 'x y', '--unverified', '--dedupe-key', 'k1', '--no-dashboard']);

r = run({ ...baseInputs, INPUT_UNVERIFIED: 'false', INPUT_NO_DASHBOARD: '' });
ok('false/empty booleans are absent', !r.seen.argv.includes('--unverified') && !r.seen.argv.includes('--no-dashboard'));

r = run(baseInputs, { STUB_JSON: '{"status":"existing"}' });
eq('status only when JSON lacks issue/url', r.outputs, { issue: '', url: '', status: 'existing' });
eq('existing exits 0', r.status, 0);

for (const code of [3, 1, 2]) {
  r = run(baseInputs, { STUB_EXIT: String(code), STUB_JSON: `{"status":"x${code}","issue":4,"url":"u"}` });
  eq(`helper exit ${code} propagates`, r.status, code);
  eq(`status still written on exit ${code}`, r.outputs.status, `x${code}`);
}

for (const [label, raw] of [['malformed', 'not json\n'], ['empty', '']]) {
  r = run(baseInputs, { STUB_RAW: raw, STUB_EXIT: '3' });
  eq(`${label} stdout never masks exit 3`, r.status, 3);
  eq(`${label} stdout leaves outputs empty`, { issue: r.outputs.issue || '', url: r.outputs.url || '', status: r.outputs.status || '' }, { issue: '', url: '', status: '' });
  r = run(baseInputs, { STUB_RAW: raw, STUB_EXIT: '0' });
  eq(`${label} stdout with exit 0 exits 1`, r.status, 1);
}

fs.rmSync(tmp, { recursive: true, force: true });

// Docs
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeIt = fs.readFileSync(path.join(root, 'README.it.md'), 'utf8');
for (const [name, doc] of [['README.md', readme], ['README.it.md', readmeIt]]) {
  ok(`${name} names the Action`, doc.includes('ToRvaLDz/trailhead/actions/capture@'));
  ok(`${name} names issues: write`, doc.includes('issues: write'));
  ok(`${name} names dedupe-key`, doc.includes('dedupe-key'));
}
const capDoc = fs.readFileSync(path.join(root, 'plugins', 'trailhead', 'skills', 'trailhead-capture', 'references', 'capture.md'), 'utf8');
ok('capture.md names the Action', capDoc.includes('actions/capture'));
for (const [name, text] of [['action.yml', yml], ['README.md', readme], ['README.it.md', readmeIt], ['capture.md', capDoc], ['test', fs.readFileSync(__filename, 'utf8').replace(/String\.fromCharCode\(0x2014\)/g, '')]]) {
  ok(`no em-dash in ${name}`, !text.includes(EMDASH));
}
ok('real helper path used by the run block exists',
  fs.existsSync(path.join(root, 'actions/capture', '../../plugins/trailhead/templates/trailhead-capture.js')));
for (const [name, doc] of [['README.md', readme], ['README.it.md', readmeIt]]) {
  const keys = [...doc.matchAll(/^\s*dedupe-key: (.+)$/gm)].map((m) => m[1]);
  ok(`${name} has a dedupe-key example`, keys.length > 0);
  for (const k of keys) {
    ok(`${name} dedupe-key example avoids unsafe contexts`, !/github\.(ref_name|workflow|head_ref|ref)\b/.test(k));
    // job ids are [A-Za-z0-9_-]; run_id and run_number are digits
    const resolved = k.replace(/\$\{\{\s*github\.(job|run_id|run_number)\s*\}\}/g, 'x1');
    ok(`${name} dedupe-key example matches the helper regex`, /^[A-Za-z0-9._:-]{1,100}$/.test(resolved));
  }
}
console.log(`capture-action.test.js: ${passed} checks passed`);
