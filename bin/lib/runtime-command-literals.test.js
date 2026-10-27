#!/usr/bin/env node
// Test statico: nessun literal di comando Claude (`/trailhead:<verb>` o `/trailhead`
// nudo) dentro stringhe/template del codice runtime. Gli hook lib e i template
// vengono copiati byte-per-byte su Codex e convertToCodex riscrive solo il
// markdown, quindi un literal qui arriverebbe cosi' com'e' a un utente Codex.
// Usare commandForm(host, verb) (host-descriptor o helper locale della lib).
// Run: node runtime-command-literals.test.js. Nessun framework: assert semplici.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = [
  { dir: 'plugins/trailhead/hooks', skip: ['plugins/trailhead/hooks/mod'] },
  { dir: 'plugins/trailhead/templates', skip: [] },
  { dir: 'bin', skip: [] },
];

// Eccezioni motivate: file (relativo alla root) + sottostringa della riga.
// Niente numeri di riga, cosi' le modifiche attorno non rompono il test.
const ALLOWLIST = [
  {
    file: 'plugins/trailhead/templates/trailhead-dashboard.js',
    contains: 'Regenerate any time with',
    reason: 'corpo del dashboard: artefatto condiviso host-neutral scritto nell\'issue, non un messaggio runtime per host',
  },
  {
    file: 'bin/trailhead.js',
    contains: '(/trailhead:*)',
    reason: 'banner dell\'installer Claude-only (il ramo Codex stampa il proprio banner)',
  },
  {
    file: 'bin/trailhead.js',
    contains: 'then run /trailhead to start',
    reason: 'banner dell\'installer Claude-only',
  },
  {
    file: 'bin/lib/codex-projection.js',
    contains: '',
    reason: 'e\' il riscrittore Claude->Codex: nomina la forma Claude per riscriverla o vietarla',
  },
  {
    file: 'bin/lib/host-descriptor.js',
    contains: "commandPrefix: '/trailhead:'",
    reason: 'dato del descriptor Claude da cui commandForm produce la forma Claude',
  },
  {
    file: 'plugins/trailhead/hooks/lib/model-defaults-review.js',
    contains: '`/trailhead:${verb}`',
    reason: 'helper commandForm della lib: l\'unico punto che produce la forma Claude',
  },
];

// `/trailhead:` seguito da un verbo, oppure `/trailhead` nudo (non parte di un
// path: non preceduto da parola, `.`, `~`, `\`, `/`, `-` e non seguito da
// parola, `:`, `/`, `\`, `-`).
const COMMAND_RE = /(?<![\w.~\\/-])\/trailhead(?::\w|(?![\w:/\\-]))/g;

function listJs(dir, skip) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || skip.includes(rel)) continue;
      out.push(...listJs(rel, skip));
    } else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
      out.push(rel);
    }
  }
  return out;
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// Una occorrenza conta solo se c'e' un apice/virgolette/backtick prima.
function insideLiteral(line, index) {
  return /['"`]/.test(line.slice(0, index));
}

function findViolations(rel, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const m of line.matchAll(COMMAND_RE)) {
      if (!insideLiteral(line, m.index)) continue;
      const allowed = ALLOWLIST.some((a) => a.file === rel && line.includes(a.contains));
      if (!allowed) out.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Sanity del rilevatore: deve fermare il literal originale e ignorare i path.
ok('detector flags the original review-offer literal',
  findViolations('x.js', "  '3) open /trailhead:config to pick per key.',").length === 1);
ok('detector flags a bare /trailhead in a literal',
  findViolations('x.js', "console.log('run /trailhead to start');").length === 1);
ok('detector ignores comment lines', findViolations('x.js', '// run /trailhead:update').length === 0);
ok('detector ignores path segments',
  findViolations('x.js', "path.join('skills/trailhead/hooks', 'refs/heads/trailhead/t1')").length === 0);
ok('detector ignores the host-neutral helper form',
  findViolations('x.js', 'const c = commandForm(host, "config");').length === 0);

// Le eccezioni in allowlist devono ancora corrispondere a qualcosa.
for (const a of ALLOWLIST) {
  ok(`allowlist file exists: ${a.file}`, fs.existsSync(path.join(ROOT, a.file)));
  ok(`allowlist reason given: ${a.file}`, a.reason.length > 0);
}

const files = SCAN_DIRS.flatMap(({ dir, skip }) => listJs(dir, skip));
ok('scan covers hook libs, templates and bin', files.length > 20);
const violations = files.flatMap((rel) => findViolations(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')));
assert.deepStrictEqual(violations, [],
  `literal di comando Claude in codice runtime (usa commandForm):\n${violations.join('\n')}`);
passed++;

console.log(`runtime-command-literals.test.js: ${passed} assertions passed`);
