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
// workflow). Self-contained, no dependencies. Pure functions exported for
// tests; runs as a hook when executed directly.

// --- tokenizing -------------------------------------------------------------

function basename(p) {
  const s = String(p).split('/');
  return s[s.length - 1];
}

// Matches a heredoc introducer anywhere it can appear on a line: `<<TAG`,
// `<<'TAG'`, `<<"TAG"`, and `<<-TAG` (which also allows the terminator line to
// be indented with leading tabs). Captures the operator's `-` and the tag
// (quoted or bare) separately.
const HEREDOC_RE = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/;

// A heredoc BODY is literal data (e.g. a script being written to a file), not
// shell statements executed in the current shell. Scan the command line by
// line; whenever a line introduces a heredoc, skip every following line up to
// and including the matching terminator line before it ever reaches the
// statement splitter below. Handles multiple heredocs on the same command and
// both quoted and unquoted tags. Best-effort, like the rest of this file: not
// a full shell parser.
function stripHeredocBodies(cmd) {
  const lines = String(cmd).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    out.push(line);
    let m;
    // A single line can introduce more than one heredoc (`cmd <<A <<B`); walk
    // left to right and skip each body in turn.
    while ((m = HEREDOC_RE.exec(line))) {
      const dashStrip = m[1] === '-';
      const tag = m[2] || m[3] || m[4];
      line = line.slice(m.index + m[0].length); // keep scanning the rest of this line for more `<<TAG`s
      if (!tag) break;
      // Skip lines until the terminator: an exact match, or (for `<<-`) the
      // tag preceded only by tabs.
      while (i + 1 < lines.length) {
        i++;
        const body = lines[i];
        const term = dashStrip ? body.replace(/^\t+/, '') : body;
        if (term === tag) break; // terminator line: consumed, not a candidate statement either
        // else: heredoc data line, deliberately NOT pushed to `out` - it must
        // never become a candidate statement.
      }
    }
  }
  return out.join('\n');
}

// Split a shell string into top-level statements on `&&`, `||`, `;`, `|`, and
// newlines, respecting single/double quotes (so a separator INSIDE a quoted
// argument, e.g. a grep pattern, does not fracture the statement). Heredoc
// bodies are stripped first (see stripHeredocBodies) so literal data written
// via `<<TAG` is never mistaken for statements. Best-effort, like the other
// guards' token walks: not a full shell parser, just enough to avoid the
// common false splits.
function splitStatements(cmd) {
  const s = stripHeredocBodies(String(cmd));
  const stmts = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; } // escaped char stays literal
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === '"') { inDouble = true; cur += c; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (c === '&' && s[i + 1] === '&') { stmts.push(cur); cur = ''; i++; continue; }
    if (c === '|' && s[i + 1] === '|') { stmts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { stmts.push(cur); cur = ''; continue; }
    cur += c;
  }
  stmts.push(cur);
  return stmts.map((t) => t.trim()).filter(Boolean);
}

// Naive whitespace tokenizer, matching the other guards' style (they accept
// the same imprecision on quoted multi-word args in exchange for simplicity).
function tokenize(stmt) {
  return String(stmt).trim().split(/\s+/).filter(Boolean);
}

function skipEnvPrefix(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return i;
}

function stripQuotes(t) {
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
      (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    return t.slice(1, -1);
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

// grep/rg/ag/sed/awk take a PATTERN (or script/program) as their first
// positional; cat/head/tail/wc/nl/less/more take only FILE positionals.
const GREP_VALUE_FLAGS = new Set([
  '-e', '-f', '-A', '-B', '-C', '-m', '-D',
  '--include', '--exclude', '--exclude-dir', '--exclude-from',
  '--after-context', '--before-context', '--context', '--max-count',
]);

const VERB_CONFIG = {
  grep: { patternFirst: true, valueFlags: GREP_VALUE_FLAGS, patternFlags: new Set(['-e']) },
  rg: { patternFirst: true, valueFlags: GREP_VALUE_FLAGS, patternFlags: new Set(['-e']) },
  ag: { patternFirst: true, valueFlags: GREP_VALUE_FLAGS, patternFlags: new Set(['-e']) },
  sed: { patternFirst: true, valueFlags: new Set(['-e', '-f']), patternFlags: new Set(['-e']) },
  awk: { patternFirst: true, valueFlags: new Set(['-f', '-v']), patternFlags: new Set() },
  cat: { patternFirst: false, valueFlags: new Set() },
  head: { patternFirst: false, valueFlags: new Set(['-n', '-c']) },
  tail: { patternFirst: false, valueFlags: new Set(['-n', '-c']) },
  wc: { patternFirst: false, valueFlags: new Set() },
  nl: { patternFirst: false, valueFlags: new Set() },
  less: { patternFirst: false, valueFlags: new Set() },
  more: { patternFirst: false, valueFlags: new Set() },
};

// Walk a verb's argument tokens (verb itself already stripped), skipping flags
// (and their separate-token values) and the leading pattern/script positional
// when the verb has one, and return the first relative FILE argument found.
function scanArgsForRelativeFile(args, config) {
  let patternConsumed = !config.patternFirst;
  for (let j = 0; j < args.length; j++) {
    const t = args[j];
    if (t === '--') continue; // end-of-options marker; remaining args are still positionals
    if (t.startsWith('-') && t !== '-') {
      if (config.valueFlags.has(t)) {
        j++; // consume its separate-token value
        if (config.patternFlags && config.patternFlags.has(t)) patternConsumed = true;
      }
      continue;
    }
    if (!patternConsumed) { patternConsumed = true; continue; }
    if (isRelativeFileArg(t)) return t;
  }
  return null;
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
  const tokens = tokenize(stmt);
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
  const tokens = tokenize(stmt);
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
