'use strict';
// wrappers.js: the ONE table of command wrappers (`sudo`, `doas`, `env`, `nice`, ...)
// and the getopt-style reading of their flags (#374). The secret guard, lib/unmodelled.js
// and the install guard each peel wrappers off a command line to find the command that
// really runs; they share this table so a flag one of them knows is never missed by
// another. The table decides only which flags take a value. What each guard does around
// it stays its own: NAME=value skipping, quote removal, `env -S` re-tokenizing, the
// `timeout` DURATION, `command -v`, and which wrappers it peels at all (a guard that
// treats a wrapper otherwise, e.g. `xargs` as an opaque runner, just does not ask).
// Self-contained: no requires.

// wrapper -> the flags that take a value (short and long forms).
const WRAPPER_FLAGS = {
  sudo: new Set([
    '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
    '-U', '--other-user', '-r', '--role', '-t', '--type', '-D', '--chdir', '-R', '--chroot',
    '-T', '--command-timeout', '-a', '--auth-type', '-c', '--login-class',
  ]),
  doas: new Set(['-a', '-C', '-u']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0', '-S', '--split-string']),
  time: new Set(['-f', '--format', '-o', '--output']),
  nohup: new Set(),
  xargs: new Set([
    '-n', '--max-args', '-I', '-a', '--arg-file', '-d', '--delimiter', '-E', '-L', '--max-lines',
    '-P', '--max-procs', '-s', '--max-chars',
  ]),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']), // + one DURATION operand
  nice: new Set(['-n', '--adjustment']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  setsid: new Set(),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']), // -t takes no value
  command: new Set(), // -v / -V only look a name up: see isLookupFlag
  builtin: new Set(),
  exec: new Set(['-a']),
};

// Which wrappers each guard peels, named so a table entry never changes a guard by
// accident. The secret guard and lib/unmodelled.js share COMMAND_WRAPPERS (`xargs` stays
// an opaque runner for the secret guard and `time` a prefix word, so neither is here).
// The install guard keeps its own set: it peels `xargs`/`time`/`setsid` but not `builtin`.
const COMMAND_WRAPPERS = new Set(['env', 'sudo', 'doas', 'nice', 'ionice', 'timeout', 'stdbuf', 'exec', 'command', 'builtin', 'nohup']);
const INSTALL_WRAPPERS = new Set(Object.keys(WRAPPER_FLAGS).filter((w) => w !== 'builtin'));

// Is `name` (already unquoted, no path) a wrapper in the table?
function isWrapper(name) {
  return Object.prototype.hasOwnProperty.call(WRAPPER_FLAGS, name);
}

// How a wrapper flag `f` consumes its value, read like getopt: { next: true } (the value
// is the NEXT token), { attached } (the value is inside this token) or {} (no value). A
// short cluster ends at its first value letter, so `-Hu root` takes the next token and
// `-uroot` carries its value attached. `--long=value` is attached, `--long value` is next.
function flagValue(f, valueFlags) {
  if (f.startsWith('--')) {
    const eq = f.indexOf('=');
    if (eq !== -1) return { attached: f.slice(eq + 1) };
    return valueFlags.has(f) ? { next: true } : {};
  }
  for (let k = 1; k < f.length; k++) {
    if (!valueFlags.has('-' + f[k])) continue;
    return k === f.length - 1 ? { next: true } : { attached: f.slice(k + 1) };
  }
  return {};
}

// Tokens the flag `f` of `wrapper` occupies: 2 when its value is the next token, else 1.
function flagWidth(f, wrapper) {
  return isWrapper(wrapper) && flagValue(f, WRAPPER_FLAGS[wrapper]).next ? 2 : 1;
}

// `env -S` / `--split-string`: its payload IS the command line, not a flag value.
function isSplitFlag(f) {
  if (f.startsWith('--')) return f === '--split-string' || f.startsWith('--split-string=');
  for (let k = 1; k < f.length; k++) {
    if (f[k] === 'S') return true;
    if ('uCa'.includes(f[k])) return false; // value letter first: S is part of its value
  }
  return false;
}

// `command -v` / `-V` (also inside a cluster like `-pv`) only describe a name and
// execute nothing, so nothing follows that can run.
function isLookupFlag(f) {
  return !f.startsWith('--') && /[vV]/.test(f);
}

// The flags of the wrapper at toks[k] (and its values), read once for every guard.
// Returns { toks, next }: `next` is the index just past the wrapper's options, and `toks`
// is rewritten when an `env -S` payload was re-tokenized in place (the payload is then
// the command line, so `next` is where it starts). opts:
//   norm      word -> the word as the shell sees it (dequote); default identity
//   tokenize  payload text -> tokens, for `env -S`; without it -S is a plain value flag
//   assign    RegExp of NAME=value words skipped after an env/sudo (default: none)
//   lookup    true: `command -v` / `-V` ends the line (next = toks.length)
//   name      the wrapper name when it is not norm(toks[k])
// Stops at `--`; a `timeout` also takes its DURATION operand.
function skipWrapperFlags(toks, k, opts = {}) {
  const norm = opts.norm || ((t) => t);
  const w = opts.name || norm(toks[k]);
  const valueFlags = isWrapper(w) ? WRAPPER_FLAGS[w] : new Set();
  const takesAssign = opts.assign && (w === 'env' || w === 'sudo');
  const skipAssigns = (j) => { while (takesAssign && j < toks.length && opts.assign.test(norm(toks[j]))) j++; return j; };
  let rest = toks;
  let j = k + 1;
  while (j < rest.length) {
    const t = norm(rest[j]);
    if (t === '--') { j = skipAssigns(j + 1); break; }
    if (t.startsWith('-')) {
      if (w === 'env' && opts.tokenize && isSplitFlag(t)) {
        const src = rest[j].startsWith('-') ? rest[j] : t; // slice the raw token when it is the flag
        const sIdx = src.indexOf('S');
        let payload;
        let end = j + 1;
        if (src.startsWith('--')) {
          const eq = src.indexOf('=');
          if (eq !== -1) payload = src.slice(eq + 1); else { payload = rest[j + 1]; end = j + 2; }
        } else if (sIdx === src.length - 1) { payload = rest[j + 1]; end = j + 2; } else payload = src.slice(sIdx + 1);
        rest = [...rest.slice(0, k), ...opts.tokenize(payload || ''), ...rest.slice(end)];
        return { toks: rest, next: k };
      }
      if (opts.lookup && w === 'command' && isLookupFlag(t)) return { toks: rest, next: rest.length };
      j += flagWidth(t, w);
    } else if (takesAssign && opts.assign.test(t)) j++;
    else break;
  }
  if (w === 'timeout' && j < rest.length) j++;
  return { toks: rest, next: j };
}

module.exports = {
  WRAPPER_FLAGS, COMMAND_WRAPPERS, INSTALL_WRAPPERS, isWrapper, flagValue, flagWidth, isSplitFlag, isLookupFlag, skipWrapperFlags,
};
