#!/usr/bin/env node
// Tests for scripts/capture-core-drift.js and the compact capture reference
// plugins/trailhead/skills/_shared/capture-core.md it guards. #330.
// Run: node capture-core-drift.test.js
// No framework: plain asserts, same style as sync-agent-blocks.test.js.
//
// Layers covered:
//   1. Pure hashLine() / parseMarkers() / evaluate() / stamp() and --check on fixtures.
//   2. The real capture-core.md against the real full core (the drift check: an edit
//      of a mirrored rule fails here as it does under --check).
//   3. Structural parity: commands, labels, icons, host forms, language key, the
//      dashboard flag, the capture SKILL.md load list, and "no third required read".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const plugin = path.join(root, 'plugins', 'trailhead');
const sharedDir = path.join(plugin, 'skills', '_shared');
const templatesDir = path.join(plugin, 'templates');
const captureDir = path.join(plugin, 'skills', 'trailhead-capture');
const drift = require('./capture-core-drift.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const read = (p) => fs.readFileSync(p, 'utf8');
const compact = read(path.join(sharedDir, 'capture-core.md'));
const capture = read(path.join(captureDir, 'references', 'capture.md'));
const skill = read(path.join(captureDir, 'SKILL.md'));
const shared = (f) => read(path.join(sharedDir, f));
const EM_DASH = '—';

// Text without the drift marker lines (they name the source files on purpose).
const withoutMarkers = (t) => t.split('\n').filter((l) => !/^<!-- core: /.test(l)).join('\n');

// --- hashLine / parseMarkers ----------------------------------------------------
{
  ok('hashLine: 8 hex chars', /^[0-9a-f]{8}$/.test(drift.hashLine('abc')));
  ok('hashLine: sha256 prefix of the line', drift.hashLine('abc') === 'ba7816bf');
  ok('hashLine: trailing whitespace and CR are ignored', drift.hashLine('abc \r') === drift.hashLine('abc'));
  ok('hashLine: a changed line changes the hash', drift.hashLine('abc') !== drift.hashLine('abd'));
  const ms = drift.parseMarkers('x\n<!-- core: a.md | some anchor | 0123abcd -->\ny\n<!-- core: b.md | other | deadbeef -->\n');
  ok('parseMarkers: one entry per marker line, in order', ms.length === 2 && ms[0].file === 'a.md' && ms[1].file === 'b.md');
  ok('parseMarkers: anchor, hash and line index are captured', ms[0].anchor === 'some anchor' && ms[0].sha === '0123abcd' && ms[0].index === 1);
  ok('parseMarkers: a malformed marker is ignored', drift.parseMarkers('<!-- core: a.md | anchor | xyz -->\n<!-- core: a.md anchor 0123abcd -->').length === 0);
  ok('findSourceLine: first line containing the anchor', drift.findSourceLine('one\ntwo anchor here\nthree anchor', 'anchor') === 'two anchor here');
  ok('findSourceLine: null when the anchor is gone', drift.findSourceLine('one\ntwo', 'anchor') === null);
}

// --- fixtures: --check on an edited source ---------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-core-drift-'));
  try {
    const srcLine = '- **Refer by name.** Every ticket has a title.';
    fs.writeFileSync(path.join(dir, 'src.md'), `intro\n${srcLine}\nother line\n`);
    const marker = (sha) => `<!-- core: src.md | Refer by name | ${sha} -->`;
    const compactPath = path.join(dir, 'compact.md');
    fs.writeFileSync(compactPath, `rule\n${marker(drift.hashLine(srcLine))}\n`);
    ok('check: a stamped marker passes', drift.check({ compactPath, sharedDir: dir }).length === 0);

    fs.writeFileSync(path.join(dir, 'src.md'), `intro\n${srcLine} Edited.\nother line\n`);
    const changed = drift.check({ compactPath, sharedDir: dir });
    ok('check: an edited source line fails and names the marker', changed.length === 1 && /src\.md \| Refer by name/.test(changed[0]) && /changed/.test(changed[0]));

    fs.writeFileSync(path.join(dir, 'src.md'), 'intro\nrewritten away\n');
    const gone = drift.check({ compactPath, sharedDir: dir });
    ok('check: a vanished anchor fails', gone.length === 1 && /anchor not found/.test(gone[0]));

    fs.rmSync(path.join(dir, 'src.md'));
    ok('check: a missing source file fails', /source file not found/.test(drift.check({ compactPath, sharedDir: dir })[0]));
    ok('check: a path outside the shared dir is not a source', /source file not found/.test(drift.check({ compactPath: (() => { fs.writeFileSync(compactPath, `<!-- core: ../x.md | a | 01234567 -->\n`); return compactPath; })(), sharedDir: dir })[0]));

    fs.writeFileSync(compactPath, 'no markers at all\n');
    ok('check: a compact file with no markers fails', drift.check({ compactPath, sharedDir: dir }).length === 1);

    // stamp: rewrites only the hashes
    fs.writeFileSync(path.join(dir, 'src.md'), `intro\n${srcLine} Edited.\n`);
    const before = `rule\n${marker('00000000')}\ntail\n`;
    const after = drift.stamp(before, (f) => (f === 'src.md' ? read(path.join(dir, 'src.md')) : null));
    ok('stamp: recomputes the hash and keeps the rest of the text', after === `rule\n${marker(drift.hashLine(`${srcLine} Edited.`))}\ntail\n`);
    let threw = false;
    try { drift.stamp(before, () => null); } catch { threw = true; }
    ok('stamp: refuses to stamp over a missing source', threw);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- CLI -------------------------------------------------------------------------
{
  const sink = () => { const c = []; return { write: (s) => c.push(s), text: () => c.join('') }; };
  const e = sink();
  ok('main: no argument is a usage error', drift.main([], sink(), e) === 2 && /usage/.test(e.text()));
  ok('main: an unknown argument is a usage error', drift.main(['--bogus'], sink(), sink()) === 2);
  ok('main: --check on the real file exits 0', drift.main(['--check'], sink(), sink()) === 0);
}

// --- the real compact file against the real core ---------------------------------
const problems = drift.check();
ok(`capture-core.md is in sync with the full shared core${problems.length ? `: ${problems.join('; ')}` : ''}`, problems.length === 0);
const markers = drift.parseMarkers(compact);
ok('capture-core.md carries drift markers', markers.length >= 10);
const mirrored = new Set(markers.map((m) => m.file));
for (const f of ['principles.md', 'ticket-language.md', 'substrate.md', 'substrate-commands.md', 'load-first.md', 'ticket-anatomy.md', 'session-handoff.md', 'configuration.md']) {
  ok(`capture-core.md mirrors at least one rule of ${f}`, mirrored.has(f));
}
ok('capture-core.md stays compact', compact.split('\n').length >= 40 && compact.split('\n').length <= 110);

// --- fenced commands -------------------------------------------------------------
function fencedLines(text) {
  const out = [];
  let inside = false;
  for (const l of text.split('\n')) {
    if (/^```/.test(l)) { inside = !inside; continue; }
    if (inside) out.push(l.trim());
  }
  return out;
}
const fenced = fencedLines(compact);
const commands = fenced.filter((l) => /^gh /.test(l));
const substrateCommands = shared('substrate-commands.md');
ok('capture-core.md has gh commands in fenced blocks', commands.length >= 8);
for (const c of commands) {
  ok(`gh command appears verbatim in substrate-commands.md: ${c.slice(0, 70)}`, substrateCommands.includes(c));
}
// A `node <templates>/<script> ...` line: the script must exist in templates/ and be
// described by the full core (its name appears in a core file), and every flag it
// passes must be one the script itself knows. The flags are checked against the
// helper's source and not the cookbook because a capture uses a subset or a newer
// flag (--update-only) the cookbook never spells out.
const allCore = fs.readdirSync(sharedDir).filter((f) => f.endsWith('.md') && f !== 'capture-core.md').map(shared).join('\n');
const nodeLines = fenced.filter((l) => /^node <templates>\//.test(l));
ok('capture-core.md calls the issue-body and dashboard helpers', nodeLines.some((l) => /trailhead-issue-body\.js/.test(l)) && nodeLines.some((l) => /trailhead-dashboard\.js/.test(l)));
for (const l of nodeLines) {
  const script = /^node <templates>\/([\w.-]+\.js)/.exec(l)[1];
  const scriptPath = path.join(templatesDir, script);
  ok(`helper exists in templates/: ${script}`, fs.existsSync(scriptPath));
  ok(`helper is described by the full core: ${script}`, allCore.includes(script));
  const src = read(scriptPath);
  for (const flag of l.match(/--[a-z][a-z-]*/g) || []) {
    ok(`helper ${script} knows ${flag}`, src.includes(`'${flag}'`) || src.includes(`${flag} `) || src.includes(`${flag}\n`));
  }
}

// --- labels ----------------------------------------------------------------------
{
  const setup = /all twenty-one: ([^)]*)\)/.exec(substrateCommands)[1];
  const labels = new Set(setup.match(/trailhead:[a-z][a-z-]*/g));
  for (const t of ['decision', 'research', 'prototype', 'build', 'bug', 'task']) labels.add(`trailhead:${t}`);
  ok('the twenty-one label set was parsed from the first-use setup', labels.size === 21);
  const named = new Set(withoutMarkers(compact).match(/(?<![\/\w])trailhead:[a-z][a-z-]*/g));
  ok('capture-core.md names labels', named.size >= 8);
  for (const l of named) {
    ok(`label is in the twenty-one set: ${l}`, labels.has(l) || l === 'trailhead:map-');
  }
}

// --- type icons ------------------------------------------------------------------
{
  const icons = (t) => {
    const out = {};
    for (const l of t.split('\n')) {
      const m = /^\|\s*`(\w+)`\s*\|\s*(\S+)\s*\|/.exec(l);
      if (m) out[m[1]] = m[2];
    }
    return out;
  };
  const full = icons(shared('ticket-anatomy.md'));
  const small = icons(compact);
  ok('the full core has the six type icons', Object.keys(full).length === 6);
  ok('the type icon table matches ticket-anatomy.md', JSON.stringify(small) === JSON.stringify(full));
}

// --- host forms, language, no em-dash, dashboard flag ------------------------------
{
  const hostLine = shared('load-first.md').split('\n').find((l) => l.startsWith('**Host command forms (standing render rule).**'));
  ok('load-first.md has the host command forms rule', Boolean(hostLine));
  ok('the host command forms sentence equals the one in load-first.md', compact.split('\n').includes(hostLine));
  for (const [name, text] of [['capture-core.md', compact], ['ticket-language.md', shared('ticket-language.md')]]) {
    ok(`${name} names config.ticket.language with default en`, text.includes('config.ticket.language') && /default `en`/.test(text));
  }
}
for (const [name, text] of [['capture-core.md', compact], ['capture.md', capture], ['the capture SKILL.md', skill]]) {
  ok(`${name} has no em-dash`, !text.includes(EM_DASH));
}
ok('capture-core.md calls the dashboard helper with --update-only', /trailhead-dashboard\.js --update-only/.test(compact));
ok('capture.md refreshes the dashboard with --update-only', /trailhead-dashboard\.js --update-only/.test(capture));
ok('capture-core.md does not call the dashboard helper without --update-only', !/trailhead-dashboard\.js(?! --update-only)/.test(compact));

// --- the capture SKILL.md load list ------------------------------------------------
{
  const m = /^## Load first[^\n]*\n([\s\S]*?)(?=^## )/m.exec(skill);
  ok('the capture SKILL.md has a Load first section', Boolean(m));
  const section = m[1];
  // SKILL.md is the file being read, never a load target.
  const files = new Set((section.match(/[\w-]+\.md/g) || []).filter((f) => f !== 'SKILL.md'));
  ok('Load first names capture-core.md', files.has('capture-core.md'));
  ok('Load first no longer names load-first.md', !files.has('load-first.md') && !/load-first/.test(section));
  ok('Load first names at most two files to read', files.size <= 2);
  ok('Load first names capture.md as the second read', section.includes('capture.md'));
}

// --- no third required read --------------------------------------------------------
{
  const names = [];
  for (const dir of [sharedDir, path.join(sharedDir, 'techniques')]) {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.md') && f !== 'capture-core.md') names.push(f.slice(0, -3));
  }
  ok('the other shared files were listed', names.length >= 20 && names.includes('principles') && names.includes('debug'));
  // A name counts when written as `<name>.md` or as a `_shared/` path (with or
  // without the extension); a bare word such as "research" is ordinary prose.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names_ = (text) => names.filter((n) => new RegExp(`(?<![\\w-])${escape(n)}\\.md(?![\\w-])|_shared/(?:techniques/)?${escape(n)}(?![\\w-])`).test(text));
  ok('capture.md names no other file of _shared/', names_(capture).length === 0);
  ok('the capture SKILL.md names no other file of _shared/', names_(skill).length === 0);
  ok('capture-core.md names no other file of _shared/ outside its drift markers', names_(withoutMarkers(compact)).length === 0);
  const pathRefs = (t) => [...t.matchAll(/_shared\/([\w-]+(?:\/[\w-]+)?(?:\.md)?)/g)].map((x) => x[1]).filter((x) => x !== 'capture-core.md');
  ok('capture.md and the SKILL.md reach into _shared/ only for capture-core.md', pathRefs(capture).length === 0 && pathRefs(skill).length === 0);
}

console.log(`capture-core-drift.test.js: ${passed} checks passed`);
