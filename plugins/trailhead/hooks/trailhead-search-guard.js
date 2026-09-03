#!/usr/bin/env node
// trailhead-search-guard.js: PreToolUse(Bash) hook.
// Structural fix for the recurring #132 -> #133 -> #134 defect: the prose
// search-command-hygiene ban (never `cd` then read/search a RELATIVE path) is
// present in every engine agent and in `_shared/techniques.md`, but a subagent
// under load still emits the banned shape, and the resulting relative read is
// non-static, so a `Read()` deny rule under bypass permissions falls back to a
// manual approval prompt (defeating headless operation). Prose hardening keeps
// regressing, so this hook makes the shape structurally impossible instead of
// merely discouraged.
//
// Blocks a SINGLE Bash command string that both:
//   (a) changes the working directory - a `cd <dir>`, `pushd <dir>`, or
//       `env -C <dir>` statement - joined to other statements via `&&`, `;`,
//       `|`, or a newline (i.e. NOT the sole statement); AND
//   (b) a later statement in that same command reads/searches a RELATIVE path
//       via a read/search verb (grep, rg, ag, cat, head, tail, wc, nl, sed,
//       awk, less, more, or `git grep`/`git log`/`git show`/`git diff`
//       without a `-C`).
//
// KNOWN LIMITATION (do not try to catch this here): a *standalone* `cd <abs>`
// in one Bash call followed by a relative read in a LATER, separate call
// relies on the shell's persisted cwd, which this stateless per-call hook
// cannot see. Blocking a lone `cd` would be far too aggressive (a legitimate,
// common shape) so it is deliberately left to the prose directive.
//
// Blocks with exit 2 + {"decision":"block","code":...,"reason":...}; allows
// everything else. Crash-safe: any error -> exit 0 (never wedge the user's
// workflow). Self-contained (its own dependency is the sibling lib/ module,
// no external packages). Pure functions exported for tests; runs as a hook
// when executed directly.

// --- tokenizing -------------------------------------------------------------
// The quote-aware tokenizer/statement-splitter (splitStatements, tokenize,
// stripQuotes, basename) and the search-verb pattern-positional-skipping
// machinery (SEARCH_VERB_CONFIG, scanArgsSkippingPattern) are shared with
// trailhead-secret-read-guard.js via lib/shell-scan.js (#135 follow-up), so
// the two guards can never drift into two divergent tokenizers.
const {
  basename,
  stripQuotes,
  splitStatements,
  tokenize,
  skipEnvPrefix,
  SEARCH_VERB_CONFIG,
  scanArgsSkippingPattern,
} = require('./lib/shell-scan.js');

// A leading grouping/keyword token that can precede the "real" first word of a
// statement without itself being that word: `(cd app && ...)`, `{ cd app; ... }`,
// `do cd "$d" && ...` (loop body), `then cd x`, `else cd x`. Stripping these
// (and a `(`/`{` glued directly onto the next token, e.g. `(cd`) lets the
// `cd`/`pushd`/read-verb checks below see the actual command even when it's
// wrapped in a subshell, brace group, or loop/conditional body.
const LEADING_GROUP_TOKENS = new Set(['(', '{', 'do', 'then', 'else']);
// A trailing grouping/keyword token (or glued punctuation) that can follow the
// real last word of a statement: `grep ... foo.txt)`, `grep ... foo.txt;`,
// `grep ... foo.txt }`, `... ; fi`, `... ; done`.
const TRAILING_GROUP_TOKENS = new Set([')', '}', ';', 'fi', 'done']);

// Strip a single leading grouping/keyword token and a single trailing
// grouping/keyword token (or glued punctuation) from an already-tokenized
// statement, so subshells, brace groups, and loop/conditional bodies don't
// hide a `cd`/read-verb from the checks that follow. Best-effort: handles the
// common shapes, not a full shell parser.
function normalizeStatementTokens(tokens) {
  let t = tokens;
  if (t.length && LEADING_GROUP_TOKENS.has(t[0])) {
    t = t.slice(1);
  } else if (t.length && (t[0][0] === '(' || t[0][0] === '{') && t[0].length > 1) {
    t = [t[0].slice(1), ...t.slice(1)];
  }
  if (t.length) {
    const last = t[t.length - 1];
    if (TRAILING_GROUP_TOKENS.has(last)) {
      t = t.slice(0, -1);
    } else {
      const stripped = last.replace(/[)};]+$/, '');
      if (stripped !== last) {
        t = stripped ? [...t.slice(0, -1), stripped] : t.slice(0, -1);
      }
    }
  }
  return t;
}

// A relative-path FILE argument: not absolute, not stdin (`-`), not a dynamic
// value we cannot resolve statically (fail open on those, same posture as the
// commit-guard's UNEXPANDABLE handling).
function isRelativeFileArg(t) {
  const bare = stripQuotes(t);
  if (!bare || bare === '-') return false;
  if (bare.startsWith('/')) return false;
  if (bare.startsWith('$') || bare.includes('$(') || bare.includes('`')) return false;
  return true;
}

// --- per-verb argument scanning ---------------------------------------------

// grep/rg/ag/sed/awk (the pattern-first search verbs) come from the shared
// lib (see lib/shell-scan.js); cat/head/tail/wc/nl/less/more take only FILE
// positionals and are specific to this guard's read-hygiene check.
const VERB_CONFIG = {
  ...SEARCH_VERB_CONFIG,
  cat: { patternFirst: false, valueFlags: new Set() },
  head: { patternFirst: false, valueFlags: new Set(['-n', '-c']) },
  tail: { patternFirst: false, valueFlags: new Set(['-n', '-c']) },
  wc: { patternFirst: false, valueFlags: new Set() },
  nl: { patternFirst: false, valueFlags: new Set() },
  less: { patternFirst: false, valueFlags: new Set() },
  more: { patternFirst: false, valueFlags: new Set() },
};

// Walk a verb's argument tokens (verb itself already stripped) for the first
// relative FILE argument found, via the shared pattern/flag-skipping walker.
function scanArgsForRelativeFile(args, config) {
  return scanArgsSkippingPattern(args, config, isRelativeFileArg);
}

// `git grep`/`git log`/`git show`/`git diff` WITHOUT a `-C` (or --work-tree):
// git grep has a pattern positional like plain grep; log/show/diff don't, so
// only their pathspec after an explicit `--` is checked (the common idiom),
// keeping this conservative rather than guessing at ref vs. path tokens.
function detectGitRelativeRead(tokens) {
  let i = 1; // tokens[0] === 'git'
  let hasC = false;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if ((tokens[i] === '-C' || tokens[i] === '--work-tree') && !tokens[i].includes('=')) {
      hasC = true;
      i += 2;
      continue;
    }
    if (tokens[i].startsWith('--work-tree=') || tokens[i].startsWith('--git-dir=')) {
      if (tokens[i].startsWith('--work-tree=')) hasC = true;
      i++;
      continue;
    }
    i++;
  }
  if (hasC) return null; // already path-explicit
  const sub = tokens[i];
  if (!['grep', 'log', 'show', 'diff'].includes(sub)) return null;
  i++;
  if (sub === 'grep') {
    return scanArgsForRelativeFile(tokens.slice(i), VERB_CONFIG.grep);
  }
  const dashIdx = tokens.indexOf('--', i);
  if (dashIdx === -1) return null;
  return scanArgsForRelativeFile(tokens.slice(dashIdx + 1), { patternFirst: false, valueFlags: new Set() });
}

// Is this statement itself a read/search verb call with a relative file arg?
function readViolationInStatement(stmt) {
  const tokens = normalizeStatementTokens(tokenize(stmt));
  const i = skipEnvPrefix(tokens);
  const rest = tokens.slice(i);
  if (rest.length === 0) return null;
  const bin = basename(rest[0]);
  if (bin === 'git') {
    const file = detectGitRelativeRead(rest);
    return file ? { verb: `git ${rest[1] || ''}`.trim(), file } : null;
  }
  const config = VERB_CONFIG[bin];
  if (!config) return null;
  const file = scanArgsForRelativeFile(rest.slice(1), config);
  return file ? { verb: bin, file } : null;
}

// Does this statement change the shell's persistent cwd (`cd`/`pushd`)? `env
// -C` is deliberately excluded here: it changes the directory only for the ONE
// command it wraps, not the rest of the script, so it's handled separately
// as a same-statement check, not this cross-statement sticky flag.
function isCdOrPushdStatement(stmt) {
  const tokens = normalizeStatementTokens(tokenize(stmt));
  const i = skipEnvPrefix(tokens);
  const bin = tokens[i];
  return bin === 'cd' || bin === 'pushd';
}

// `env -C <dir> <cmd> …`: the directory change and the read live in the SAME
// statement (env execs its argument as a single command with that cwd), so
// this is checked independently of the cross-statement `cwdChanged` flag.
function envDashCRelativeRead(stmt) {
  const tokens = tokenize(stmt);
  let i = skipEnvPrefix(tokens);
  if (basename(tokens[i]) !== 'env') return null;
  i++;
  let foundC = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C') { foundC = true; i += 2; break; }
    if (t.startsWith('--chdir=')) { foundC = true; i += 1; break; }
    if (t.startsWith('-')) { i++; continue; } // some other env flag, best-effort skip
    break; // reached the wrapped command
  }
  if (!foundC) return null;
  const rest = tokens.slice(i);
  if (rest.length === 0) return null;
  const bin = basename(rest[0]);
  if (bin === 'git') {
    const file = detectGitRelativeRead(rest);
    return file ? { verb: 'git', file } : null;
  }
  const config = VERB_CONFIG[bin];
  if (!config) return null;
  const file = scanArgsForRelativeFile(rest.slice(1), config);
  return file ? { verb: bin, file } : null;
}

// --- top-level detection -----------------------------------------------------

// Detect the banned shape across the whole command. Returns
// { verb, file } on a hit, or null. Pure, exported for tests.
// KNOWN NARROWER GAP (deliberately not implemented): `cd app && grep -rn TODO`
// with no path argument at all implicitly searches the (now-relative) cwd,
// but adding that case risks false-positiving on legitimate stdin-reading
// commands, so it is left to the prose directive.
function detectSearchHygieneViolation(cmd) {
  const statements = splitStatements(cmd);
  let cwdChanged = false;
  for (let idx = 0; idx < statements.length; idx++) {
    const stmt = statements[idx];

    const envHit = envDashCRelativeRead(stmt);
    if (envHit) return envHit;

    if (cwdChanged) {
      const hit = readViolationInStatement(stmt);
      if (hit) return hit;
    }

    // A `cd`/`pushd` only counts when it is joined to a LATER statement (not
    // the sole statement) - a lone standalone `cd` is the known limitation
    // above and must never be blocked here.
    if (isCdOrPushdStatement(stmt) && idx < statements.length - 1) {
      cwdChanged = true;
    }
  }
  return null;
}

function block(hit) {
  const reason =
    "trailhead search-hygiene: a 'cd <dir>' (or pushd/env -C) followed by a relative " +
    `${hit.verb} read (\`${hit.file}\`) makes the read target non-static, which trips the ` +
    'Read() deny rule under bypass permissions (prompting for manual approval instead of ' +
    'running headless). Pass explicit paths instead and never cd first: ' +
    'grep -niE "<patterns>" <abs>/<file>, git -C <abs> ..., or use the Grep/Read tools.';
  process.stdout.write(JSON.stringify({ decision: 'block', code: 'SEARCH_HYGIENE_VIOLATION', reason }));
  process.exit(2);
}

function run(data) {
  let cmd = '';
  try {
    cmd = (JSON.parse(data).tool_input || {}).command || '';
  } catch {
    process.exit(0); // unparseable input: nothing to gate
  }
  try {
    const hit = detectSearchHygieneViolation(cmd);
    if (hit) block(hit);
  } catch {
    // fall through to allow: a guard must never wedge the workflow
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends -> give up
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { detectSearchHygieneViolation };
