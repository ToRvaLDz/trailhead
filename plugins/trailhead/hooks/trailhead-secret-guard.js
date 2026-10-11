#!/usr/bin/env node
// trailhead-secret-guard.js: PreToolUse(Bash) hook.
// trailhead posts a lot to GitHub Issues/PRs (ticket bodies, engine comments,
// codebase/conventions issues, resolutions) while working on codebases that hold
// secrets. This is the outbound barrier: it scans what a `gh` write is about to
// post to an issue/PR/comment and BLOCKS if it looks like a secret is in it, so
// nothing sensitive lands on the tracker.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Fail-OPEN on error to keep the workflow moving, but the failure is made
// OBSERVABLE (an advisory), never byte-identical to a clean pass: once a write is
// identified, a scan error emits a "could-not-scan" advisory instead of silently
// allowing. (Anti-pattern: a guard whose failure looks exactly like a success.)
// Self-contained. Pure functions (incl. evaluate) are exported for tests and for
// the merged trailhead-bash-guards.js; runs as a hook when executed directly.

const fs = require('fs');
const path = require('path');
const { parseGhSubcommand } = require('./lib/gh-subcommand.js');
const { splitStatementsWithSeparators, tokenize } = require('./lib/shell-scan.js');

// High-confidence secret formats: a match here is almost never a false positive.
const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'OpenAI/Anthropic key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Stripe live key', re: /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'JWT / Supabase key', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/ },
];

// Assignment heuristic: a secret-named key set to a real-looking value.
const ASSIGN_RE =
  /\b(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|bearer|dsn|conn(?:ection)?[_-]?string)\b\s*[:=]\s*["']?([^\s"']{8,})/i;
// Values that are clearly NOT a real secret (placeholders, env refs, redactions).
const SAFE_VALUE =
  /^(?:\$|\$\{|<|\*{2,}|x{3,}|redacted|your[-_]|example|placeholder|dummy|test|todo|none|null|true|false|process\.env|import\.meta|os\.environ)/i;

// Kind of tracker write ('issue' | 'pr' | 'api') one statement performs, or null.
function writeKind(stmt) {
  const parsed = parseGhSubcommand(stmt);
  if (!parsed) return null;
  const { sub, verb } = parsed;
  if ((sub === 'issue' || sub === 'pr') && ['create', 'comment', 'edit', 'review'].includes(verb)) {
    return sub;
  }
  if (sub === 'api' && /(?:^|\s)(?:-f|-F|--field|--raw-field)\s+['"]?body=/.test(stmt)) return 'api';
  return null;
}

// --- static shell expansion (just enough to find a --body-file path) -----------

// Look a variable up: variables set earlier in the command first, then the hook's
// environment. null = unknown or recorded as unresolvable.
function lookupVar(name, vars, env) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  const v = env[name];
  return typeof v === 'string' ? v : null;
}

// Expand the `$...` at text[i]. Only $NAME and ${NAME} are understood; command
// substitution, parameter operators and positional/special params are unresolvable.
// Returns { value, next } or { unresolved }.
function expandDollar(text, i, vars, env) {
  const rest = text.slice(i + 1);
  let name;
  let len;
  const braced = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
  if (braced) {
    name = braced[1];
    len = braced[0].length;
  } else if (rest[0] === '{') {
    return { unresolved: 'parameter expansion operator' };
  } else if (rest[0] === '(') {
    return { unresolved: 'command substitution' };
  } else if (/^[0-9@*#?$!-]/.test(rest)) {
    return { unresolved: `special parameter $${rest[0]}` };
  } else {
    const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (!bare) return { value: '$', next: i + 1 }; // a lone $ is literal
    name = bare[0];
    len = name.length;
  }
  const v = lookupVar(name, vars, env);
  if (v === null) return { unresolved: `unknown variable ${name}` };
  return { value: v, next: i + 1 + len };
}

// Expand one shell word the way bash would for a plain argument: single quotes are
// literal, double quotes expand $NAME/${NAME} only, a bare word also expands a
// leading `~`/`~/` to HOME. Returns { value } or { unresolved: reason }.
function expandWord(word, vars, env) {
  let out = '';
  let i = 0;
  if (word[0] === '~') {
    if (word.length > 1 && word[1] !== '/') return { unresolved: 'user home (~user)' };
    const home = lookupVar('HOME', vars, env);
    if (home === null) return { unresolved: 'unknown variable HOME' };
    out = home;
    i = 1;
  }
  while (i < word.length) {
    const c = word[i];
    if (c === "'") {
      const close = word.indexOf("'", i + 1);
      if (close === -1) return { unresolved: 'unterminated quote' };
      out += word.slice(i + 1, close);
      i = close + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= word.length) return { unresolved: 'unterminated quote' };
        const d = word[i];
        if (d === '"') { i++; break; }
        if (d === '`') return { unresolved: 'command substitution' };
        if (d === '\\' && i + 1 < word.length) {
          const n = word[i + 1];
          out += '$`"\\'.includes(n) ? n : d + n;
          i += 2;
        } else if (d === '$') {
          const r = expandDollar(word, i, vars, env);
          if (r.unresolved) return r;
          out += r.value;
          i = r.next;
        } else {
          out += d;
          i++;
        }
      }
    } else if (c === '\\' && i + 1 < word.length) {
      out += word[i + 1];
      i += 2;
    } else if (c === '$') {
      const r = expandDollar(word, i, vars, env);
      if (r.unresolved) return r;
      out += r.value;
      i = r.next;
    } else if (c === '`') {
      return { unresolved: 'command substitution' };
    } else {
      out += c;
      i++;
    }
  }
  return { value: out };
}

// The --body-file path of one gh statement, resolved WITHOUT running anything.
//   { path }       an absolute path to read
//   { unresolved } the path cannot be known statically (reason given): fail closed
//   null           no --body-file/-F, or it reads stdin (`-`)
// `vars` are the variables set earlier in the command (name -> string, or null when
// unresolvable), `env` the hook's environment. A relative path resolves against
// `cwd` (process.cwd() when undefined); cwd === null means the working directory is
// no longer known (an earlier cd), so a relative path is unresolved.
function resolveBodyFile(stmt, vars, env, cwd) {
  const toks = tokenize(stmt);
  let raw = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--body-file' || t === '-F') raw = toks[i + 1] === undefined ? null : toks[i + 1];
    else if (t.startsWith('--body-file=')) raw = t.slice('--body-file='.length);
    else if (t.startsWith('-F=')) raw = t.slice('-F='.length);
  }
  if (raw === null || raw === '-' || raw.startsWith('<')) return null; // stdin/heredoc already in the command string
  const r = expandWord(raw, vars, env);
  if (r.unresolved) return { unresolved: r.unresolved };
  if (path.isAbsolute(r.value)) return { path: r.value };
  if (cwd === null) return { unresolved: 'relative path after cd (working directory unknown)' };
  return { path: path.resolve(cwd === undefined ? process.cwd() : cwd, r.value) };
}

// --- variable tracking across a compound command -------------------------------

const ASSIGN_TOKEN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const DECL_KEYWORDS = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);

// [[name, rawValue], ...] when the statement is only assignments (optionally behind
// export/declare/...), else null. `D=v cmd ...` (an inline prefix) is not one.
function parseAssignments(text) {
  const toks = tokenize(text);
  const decl = DECL_KEYWORDS.has(toks[0]);
  const out = [];
  for (let i = decl ? 1 : 0; i < toks.length; i++) {
    const m = ASSIGN_TOKEN_RE.exec(toks[i]);
    if (m) out.push([m[1], m[2]]);
    else if (!(decl && (toks[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*$/.test(toks[i])))) return null;
  }
  return decl || out.length ? out : null;
}

function changesDir(text) {
  const toks = tokenize(text);
  let i = 0;
  while (i < toks.length && ASSIGN_TOKEN_RE.test(toks[i])) i++;
  return ['cd', 'pushd', 'popd'].includes(toks[i]);
}

// Every `gh` tracker write in a (possibly compound) command, in order:
// { kind, text, vars, cwdKnown }. The command is split into statements (`;`, `&&`,
// `||`, `|`, `&`, newline) and each is checked on its own: `D=/x && gh issue comment
// ...` or `cd d && gh pr comment ...` is a write even though the string does not
// START with gh. `vars` are the variables the write can see: a pure `NAME=v`
// statement propagates, except in a pipeline or a backgrounded statement (a
// subshell); an inline `NAME=v gh ...` prefix is the child's environment only.
// `cwdKnown` turns false after a cd/pushd/popd.
function ghWrites(cmd, env = process.env) {
  const writes = [];
  let vars = {};
  let cwdKnown = true;
  let prevSep = null;
  for (const { text, sep } of splitStatementsWithSeparators(cmd)) {
    const subshell = sep === '|' || sep === '&' || prevSep === '|' || prevSep === '&';
    prevSep = sep;
    const kind = writeKind(text);
    if (kind) {
      writes.push({ kind, text, vars, cwdKnown });
      continue;
    }
    const assigns = parseAssignments(text);
    if (assigns) {
      if (!subshell) {
        const next = { ...vars };
        for (const [name, raw] of assigns) {
          const r = expandWord(raw, next, env);
          next[name] = r.unresolved ? null : r.value;
        }
        vars = next;
      }
      continue;
    }
    if (changesDir(text)) cwdKnown = false;
  }
  return writes;
}

// Is this command a `gh` write of issue/PR/comment text? Returns the kind of the
// first write, or null.
function ghIssueWrite(cmd, env = process.env) {
  const first = ghWrites(cmd, env)[0];
  return first ? first.kind : null;
}

// For gh issue/pr, the body may live in a --body-file <path>; read it too.
// The path is quoted ("..."/'...') or bare. A bare path stops at whitespace AND
// at shell metacharacters (; | & ( ) < > `): in a compound command like
// `gh ... --body-file /tmp/x.md; echo done` the `;` abuts the path with no
// space, so a naive [^\s]+ would swallow it into the filename and the read would
// ENOENT, turning a clean write into a spurious could-not-scan (and, worse, a
// real body left unscanned). Quoted paths keep those characters verbatim.
function bodyFileText(cmd) {
  const m = cmd.match(/(?:--body-file|(?<![-\w])-F)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"';|&()<>`]+))/);
  if (!m) return '';
  const path = m[1] || m[2] || m[3];
  if (path === '-' || path.startsWith('<')) return ''; // stdin/heredoc already in the command string
  return fs.readFileSync(path, 'utf8').slice(0, 1_000_000);
}

function scan(text, env = process.env) {
  if (env.TRAILHEAD_SECRETGUARD_THROW === '1') throw new Error('forced fault (test seam)');
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  const a = text.match(ASSIGN_RE);
  if (a && !SAFE_VALUE.test(a[2])) return `hardcoded ${a[1].toLowerCase()}`;
  return null;
}

// A scan we could NOT complete on a write we DID identify: surface it, don't hide it.
function unscannedVerdict(kind, err) {
  const detail = String((err && err.message) || err || 'unknown').slice(0, 120);
  return {
    kind: 'advise',
    stderr: `trailhead secret-guard: could not scan this ${kind} write (${detail}): NOT verified secret-free\n`,
    payload: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `⚠️ trailhead secret-guard could NOT complete its scan of this ${kind} write (${detail}). ` +
          'It did NOT verify the content is secret-free. Check the body by hand before it lands, or re-run. ' +
          'Do not treat this as a clean pass.',
      },
    },
  };
}

// Pure verdict for one command: allow | block {payload} | advise {payload, stderr}.
// Never exits or writes. `env` carries the test seam so the merged runner's
// environment is the one honoured.
function evaluate(cmd, { env = process.env } = {}) {
  const kind = ghIssueWrite(cmd);
  if (!kind) return { kind: 'allow' }; // not a tracker write: out of scope

  // From here we KNOW it's a tracker write, so a scan failure must be OBSERVABLE.
  try {
    const text = cmd + '\n' + (kind !== 'api' ? bodyFileText(cmd) : '');
    const hit = scan(text, env);
    if (hit) {
      return {
        kind: 'block',
        payload: {
          decision: 'block',
          code: 'SECRET_IN_ISSUE_WRITE',
          reason:
            `trailhead: this ${kind === 'api' ? 'GitHub API write' : `gh ${kind}`} looks like it contains a secret (${hit}). ` +
            'Nothing sensitive may land on the tracker. Redact it: replace the value with `<REDACTED>` or an env-var reference ' +
            '(e.g. `$SUPABASE_KEY`), and post again. If this is a false positive (not a real secret), reword so it no longer matches a credential pattern.',
        },
      };
    }
  } catch (e) {
    return unscannedVerdict(kind, e); // fail open, but loudly: never a silent clean-looking pass
  }
  return { kind: 'allow' };
}

function run(data) {
  let cmd = '';
  try {
    cmd = (JSON.parse(data).tool_input || {}).command || '';
  } catch {
    process.exit(0); // unparseable input: nothing meaningful to say
  }
  const v = evaluate(cmd);
  if (v.kind === 'block') {
    process.stdout.write(JSON.stringify(v.payload));
    process.exit(2);
  }
  if (v.kind === 'advise') {
    process.stderr.write(v.stderr);
    process.stdout.write(JSON.stringify(v.payload));
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends → give up (no write identified)
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { ghIssueWrite, ghWrites, resolveBodyFile, bodyFileText, scan, evaluate, SECRET_PATTERNS };
