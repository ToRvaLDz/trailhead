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
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid']),
  command: new Set(), // -v / -V only look a name up: see isLookupFlag
  builtin: new Set(),
  exec: new Set(['-a']),
};

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

module.exports = { WRAPPER_FLAGS, isWrapper, flagValue, flagWidth, isSplitFlag, isLookupFlag };
