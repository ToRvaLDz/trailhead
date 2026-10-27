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
    contains: 'Never \\`/trailhead:<verb>\\`',
    reason: 'testo del SKILL.md Codex: nomina la forma Claude proprio per vietarla all\'agente',
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

// `/trailhead:` (anche seguito da `${`, `*`, `<verb>` o concatenato) oppure
// `/trailhead` nudo. Non conta dentro un path: non preceduto da parola, `.`,
// `~`, `\`, `/`, `-` e non seguito da parola, `:`, `/`, `\`, `-`.
const COMMAND_RE = /(?<![\w.~\\/-])\/trailhead(?::|(?![\w:/\\-]))/g;

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

// Scanner minimale a stati sull'intero file: marca i caratteri che stanno
// dentro stringhe ('...', "...") e template (`...`, anche su piu' righe, con i
// loro ${...}); commenti e literal regex sono saltati. Non e' un parser JS
// completo: una regex e' riconosciuta dal carattere significativo precedente.
const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
function literalMask(text) {
  const mask = new Uint8Array(text.length);
  let i = 0;
  let prev = '';
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      mask[i] = 1;
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') { mask[i] = 1; i++; }
        if (c !== '`' && text[i] === '\n') break;
        mask[i] = 1;
        i++;
      }
      if (i < text.length) mask[i] = 1;
      i++;
      prev = c;
    } else if (c === '/' && (REGEX_PREV.has(prev) || prev === 'return')) {
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== '\n' && (inClass || text[i] !== '/')) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        i++;
      }
      i++;
      prev = ')';
    } else {
      if (!/\s/.test(c)) {
        const word = /[A-Za-z_$]/.test(c) ? text.slice(i).match(/^[\w$]+/)[0] : c;
        prev = word === 'return' ? 'return' : word.length > 1 ? 'a' : c;
        i += word.length;
        continue;
      }
      i++;
    }
  }
  return mask;
}

const used = new Set();

function findViolations(rel, text) {
  const out = [];
  const mask = literalMask(text);
  const lines = text.split('\n');
  const starts = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  for (const m of text.matchAll(COMMAND_RE)) {
    if (!mask[m.index]) continue;
    let ln = starts.findIndex((st, k) => k === starts.length - 1 || starts[k + 1] > m.index);
    const line = lines[ln];
    const idx = ALLOWLIST.findIndex((a) => a.file === rel && line.includes(a.contains));
    if (idx >= 0) { used.add(idx); continue; }
    out.push(`${rel}:${ln + 1}: ${line.trim()}`);
  }
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
ok('detector flags a concatenated literal', findViolations('x.js', "const c = '/trailhead:' + v;").length === 1);
ok('detector flags a template literal with interpolation', findViolations('x.js', 'const c = `/trailhead:${v}`;').length === 1);
ok('detector flags a literal on a later line of a multi-line template',
  findViolations('x.js', 'const t = `first line\nrun /trailhead:config now`;').length === 1);
ok('detector flags the glob and placeholder forms',
  findViolations('x.js', "a('/trailhead:*'); b('/trailhead:<verb>');").length === 2);
ok('detector ignores a regex literal with an escaped slash',
  findViolations('x.js', "const R = /^refs\\/heads\\/trailhead\\/t(\\d+)$/; const q = /['\"]/;").length === 0);
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
const unused = ALLOWLIST.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.contains}`);
assert.deepStrictEqual(unused, [], `voci di allowlist mai usate (da rimuovere):\n${unused.join('\n')}`);
passed++;

console.log(`runtime-command-literals.test.js: ${passed} assertions passed`);
