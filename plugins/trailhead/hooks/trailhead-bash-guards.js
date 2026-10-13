#!/usr/bin/env node
// trailhead-bash-guards.js: PreToolUse(Bash) hook.
// One process for the five Bash guards (commit, secret, install, search, body)
// instead of five: each Bash call pays a single node start-up. The guards keep
// their own modules and verdicts; this runner only calls each one's pure
// evaluate(cmd) in a fixed order (commit, secret, install, search, body).
//   - First block wins: its payload goes to stdout and the hook exits 2; later
//     guards do not run. An earlier advisory keeps its stderr line.
//   - No block: advisories (secret-guard's "could not scan") surface on stderr
//     and in one additionalContext; otherwise exit 0 with empty stdout.
//   - Failure posture is unchanged per guard: a throwing guard counts as allow
//     and the others still run; a guard module that fails to load is skipped
//     with a one-line stderr warning.
//   - --guards=<name,...> picks the guards (default: all five). The Codex install
//     ships no search-guard and registers --guards=commit,secret,install,body.
//     A missing, empty, malformed or unknown-name list falls back to all five, so
//     a config typo never disables a guard.
//   - TRAILHEAD_MOD_GUARDS=<name,...>@<epoch-ms>: the mod (which has ported those
//     guards) stamps the guards it already ran; a stamp no older than
//     MOD_GUARDS_FRESH_MS skips exactly those. Missing, malformed, future-dated or
//     stale -> skip nothing.
// Crash-safe: unparseable input or any internal error -> exit 0.
// Self-contained, no dependencies. Pure functions are exported for tests.

const GUARD_ORDER = ['commit', 'secret', 'install', 'search', 'body'];
const MOD_GUARDS_FRESH_MS = 5000;
const MOD_GUARDS_RE = /^([a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)*)@(\d+)$/;

// Guards the mod already ran, as a Set of names to skip (empty when the stamp is
// absent, malformed, future-dated or stale).
function parseModGuards(value, now = Date.now()) {
  const m = typeof value === 'string' ? MOD_GUARDS_RE.exec(value) : null;
  if (!m) return new Set();
  const age = now - Number(m[2]);
  if (!(age >= 0 && age <= MOD_GUARDS_FRESH_MS)) return new Set();
  return new Set(m[1].split(',').filter((n) => GUARD_ORDER.includes(n)));
}

// Guards selected by --guards=<name,...>, in canonical order. Anything but a
// well-formed list of known names means all five.
function parseGuardsArg(argv) {
  const arg = argv.find((a) => a.startsWith('--guards='));
  if (!arg) return GUARD_ORDER;
  const names = arg.slice('--guards='.length).split(',');
  if (!names.every((n) => GUARD_ORDER.includes(n))) return GUARD_ORDER;
  return GUARD_ORDER.filter((n) => names.includes(n));
}

// Lazy require: only the selected guards are loaded. Returns null on failure.
function loadEvaluator(name) {
  try {
    const mod = require(`./trailhead-${name}-guard.js`);
    return typeof mod.evaluate === 'function' ? mod.evaluate : null;
  } catch {
    return null;
  }
}

// The advisory for a selected guard whose module could not be loaded.
function loadFailureAdvisory(name) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `⚠️ trailhead bash-guards could NOT load the ${name} guard, so it did NOT check this command. ` +
        'Its module is missing or broken: reinstall or update trailhead. Do not treat this as a clean pass.',
    },
  };
}

// Run the selected, non-skipped guards over one command.
// Returns { code, stdout, stderr } for the caller to emit.
function runGuards(cmd, { guards = GUARD_ORDER, env = process.env, now = Date.now(), evaluators = {}, cwd } = {}) {
  const skip = parseModGuards(env.TRAILHEAD_MOD_GUARDS, now);
  let stderr = '';
  const advisories = [];
  for (const name of GUARD_ORDER) {
    if (!guards.includes(name) || skip.has(name)) continue;
    const evaluate = evaluators[name] || loadEvaluator(name);
    if (!evaluate) {
      // Fail open like the guard itself, but loudly: a stderr line alone is
      // hidden on exit 0, so the skip also reaches the session as context.
      stderr += `trailhead bash-guards: could not load the ${name} guard, skipping it\n`;
      advisories.push(loadFailureAdvisory(name));
      continue;
    }
    let verdict;
    try {
      verdict = evaluate(cmd, { env, cwd });
    } catch {
      continue; // same posture as each guard on its own: fail open
    }
    if (!verdict) continue;
    if (verdict.kind === 'block') {
      return { code: 2, stdout: JSON.stringify(verdict.payload), stderr };
    }
    if (verdict.kind === 'advise') {
      stderr += verdict.stderr || '';
      advisories.push(verdict.payload);
    }
  }
  if (advisories.length === 0) return { code: 0, stdout: '', stderr };
  if (advisories.length === 1) return { code: 0, stdout: JSON.stringify(advisories[0]), stderr };
  const context = advisories.map((p) => p.hookSpecificOutput.additionalContext).join('\n');
  const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } });
  return { code: 0, stdout, stderr };
}

function run(data, argv) {
  let cmd = '';
  let cwd;
  try {
    const input = JSON.parse(data);
    cmd = (input.tool_input || {}).command || '';
    cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined; // relative body-file paths resolve against it
  } catch {
    process.exit(0); // unparseable input: nothing meaningful to say
  }
  let result;
  try {
    result = runGuards(cmd, { guards: parseGuardsArg(argv), cwd });
  } catch {
    process.exit(0); // never wedge the workflow
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.code);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends -> give up
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data, process.argv.slice(2));
  });
}

module.exports = { parseModGuards, parseGuardsArg, runGuards, MOD_GUARDS_FRESH_MS, GUARD_ORDER };
