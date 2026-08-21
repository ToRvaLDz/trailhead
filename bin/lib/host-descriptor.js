'use strict';
// host-descriptor.js: trailhead's host descriptor + runtime detection module.
//
// This is the single source of truth for the 3 integration axes trailhead
// projects onto each supported host (commandSurface, subagentToolkit,
// hookBus), the frozen per-host descriptors built from them, and the
// projection/degradation helpers that describe what each host gets (or loses)
// relative to Claude. It is sized to trailhead's actual footprint: 2 hosts
// (claude, codex), not a general n-host framework.
//
// Two consumers:
//   - install-time: the installer (a separate ticket, #23) reads HOSTS/AXES/
//     configDirFor/hyphenateCommand/emitsAgentToml to lay out commands,
//     prompts, and config for whichever host it's installing into.
//   - run-time: detectHost() lets the engine's inline rules (executed as
//     Claude Agent-tool text, not compiled code) figure out which host they
//     are actually running under, without any installer having run first.
//
// This is a scaled-down mirror, in shape only, of GSD's host-integration.cjs
// (the axes + per-host descriptor table) and host-runtime-detection.cjs (the
// detection ladder + never-throw contract). GSD's versions are TS-compiled
// and carry far more hosts, adapters, and history; this file intentionally
// does not copy that machinery, only the pattern, dimensioned down to what
// trailhead needs today.
//
// Self-contained: no dependencies beyond Node's stdlib. Every exported
// function is pure. All descriptor data is frozen so callers can't mutate
// the single source of truth out from under each other.

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Axis 1: the 3 closed vocabularies (decision #17) ---------------------
// Each axis is a closed set of values a host can take. Closed on purpose:
// a new value here is a design decision (a new ticket), not a typo away.
const AXES = Object.freeze({
  // How a host surfaces trailhead's commands to the user.
  //   'slash-file'    Claude: namespaced slash-command files under commands/trailhead/*.md
  //   'hyphen-prompt' Codex:  flat, hyphenated prompt files (trailhead-work.md, etc.)
  commandSurface: Object.freeze(['slash-file', 'hyphen-prompt']),
  // Whether the host has a dedicated subagent/Task-fanout toolkit.
  //   'full' Claude: the Agent tool, real subagent fan-out
  //   'none' Codex:  no such toolkit; everything the engine needs runs inline
  subagentToolkit: Object.freeze(['full', 'none']),
  // Whether the host has a lifecycle hook bus (PreToolUse/PostToolUse/Stop/...).
  //   'host' Claude: native hooks
  //   'none' Codex:  no hook bus; guardrails must degrade to something else
  hookBus: Object.freeze(['host', 'none']),
});

// --- Axis 2: per-host descriptors -------------------------------------------
// Each descriptor is a frozen data record, not behavior. Anything that reads
// like "if codex, do X" should be reading one of these fields, not branching
// on a host-name string sprinkled through the codebase.
const HOSTS = Object.freeze({
  claude: Object.freeze({
    label: 'Claude Code',
    configDirEnv: 'CLAUDE_CONFIG_DIR',
    configDirDefault: '.claude',
    axes: Object.freeze({
      commandSurface: 'slash-file',
      subagentToolkit: 'full',
      hookBus: 'host',
    }),
    // Structural layout only. The exact target tree (which files land where)
    // is refined by the installer, ticket #23; this just says "namespaced
    // dir of .md files" so the installer has a starting shape to work from.
    commands: Object.freeze({
      layout: 'namespaced-dir',
      dir: 'commands/trailhead',
      ext: '.md',
    }),
    // Explicit data flag, deliberately NOT derived from subagentToolkit:
    // "full toolkit" and "emits an agents.toml" are independent facts. Claude
    // uses its native Agent tool and has no reason to emit one.
    emitsAgentToml: false,
    hooks: Object.freeze({ bus: 'host' }),
  }),
  codex: Object.freeze({
    label: 'Codex',
    configDirEnv: 'CODEX_HOME',
    configDirDefault: '.codex',
    axes: Object.freeze({
      commandSurface: 'hyphen-prompt',
      subagentToolkit: 'none',
      hookBus: 'none',
    }),
    commands: Object.freeze({
      layout: 'flat-hyphen-prompts',
      ext: '.md',
    }),
    // Also explicit, also independent from the axis: today's codex support
    // (approach A) runs everything inline under 'none', no agents.toml is
    // emitted. A future approach-B codex integration (spawning real Codex
    // sub-sessions as pseudo-subagents via an agents.toml manifest) would
    // flip this to true without changing subagentToolkit's vocabulary.
    emitsAgentToml: false,
    // No hook bus: guardrails (secret-guard, commit-guard, etc.) degrade
    // per decision #16, see degradations() below.
    hooks: Object.freeze({ bus: 'none' }),
  }),
});

// --- Helper: getHost ---------------------------------------------------------
// Resolve a host name to its descriptor. Throws on an unknown name, naming
// both the offender and the known hosts, so a typo fails loud at the call
// site instead of silently returning undefined.
function getHost(name) {
  // Own-property check, not `HOSTS[name]`: a bare index walks the prototype
  // chain, so inherited keys ('toString', 'constructor', ...) would slip past
  // a truthiness guard and hand back a non-descriptor instead of throwing.
  if (!Object.prototype.hasOwnProperty.call(HOSTS, name)) {
    throw new Error(`host-descriptor: unknown host "${name}" (known hosts: ${Object.keys(HOSTS).join(', ')})`);
  }
  return HOSTS[name];
}

// Normalize a "host" argument that may already be a descriptor (has `axes`)
// or may be a name string, to a descriptor. Used by the small helpers below
// that accept either, per the spec.
function resolveHost(host) {
  return typeof host === 'string' ? getHost(host) : host;
}

// --- Helper: configDirFor ----------------------------------------------------
// Resolve where a host's config directory lives: an explicit env override
// first (e.g. CLAUDE_CONFIG_DIR, CODEX_HOME), falling back to the host's
// default dir under the user's homedir (e.g. ~/.claude, ~/.codex).
function configDirFor(host, opts = {}) {
  const descriptor = resolveHost(host);
  const env = opts.env || process.env;
  const homedir = opts.homedir || os.homedir();
  const override = env[descriptor.configDirEnv];
  if (typeof override === 'string' && override.trim() !== '') {
    return override;
  }
  return path.join(homedir, descriptor.configDirDefault);
}

// --- Helper: hyphenateCommand -------------------------------------------------
// Normalize a command name to Codex's flat hyphen-prompt surface: strip a
// leading slash, replace ':' namespace separators with '-'.
//   '/trailhead:work' -> 'trailhead-work'
//   'trailhead:work'  -> 'trailhead-work'
//   '/trailhead'      -> 'trailhead'
function hyphenateCommand(name) {
  return String(name).trim().replace(/^\//, '').replace(/:/g, '-');
}

// --- Helper: emitsAgentToml ---------------------------------------------------
function emitsAgentToml(host) {
  return resolveHost(host).emitsAgentToml;
}

// --- Helper: degradations -----------------------------------------------------
// Plain data-table lookup of what degrades on a given host relative to
// Claude (the reference host with the full toolkit and a native hook bus).
// Deliberately NOT clever: no inference engine, just entries keyed off the
// axes that produced them, so the list stays legible and auditable.
function degradations(host) {
  const descriptor = resolveHost(host);
  const entries = [];

  if (descriptor.axes.subagentToolkit === 'none') {
    entries.push({
      from: 'subagent fan-out (research, codebase-map, review, plan, execute)',
      to: 'inline sequential execution in the main session',
    });
    entries.push({
      from: 'per-activity model split (models.*)',
      to: 'collapses to a single session model',
    });
  }

  if (descriptor.axes.hookBus === 'none') {
    entries.push({
      from: 'lifecycle hooks (secret-guard, commit-guard, injection-scanner, check-update)',
      to: 'a git commit-msg hook plus inline prose guardrails (decision #16)',
    });
  }

  return entries;
}

// --- Helper: modelsCollapseNotice --------------------------------------------
// The one-time notice the engine surfaces at session start when models.* is
// configured on a subagent-less host, where it cannot take effect: every
// activity collapses to the single session model (see degradations()). Pure:
// returns the notice string, or null when there is nothing to say (the host
// has a subagent toolkit, or no models.* is set). The caller owns the
// "one-time" bookkeeping (a marker file) and how the string is shown, so this
// stays pure and trivially testable, mirroring detectHost/degradations.
function modelsCollapseNotice(host, config) {
  const descriptor = resolveHost(host);
  if (descriptor.axes.subagentToolkit !== 'none') return null;
  const models = config && typeof config === 'object' ? config.models : null;
  if (!models || typeof models !== 'object') return null;
  const set = Object.keys(models).filter(
    (k) => models[k] != null && String(models[k]).trim() !== ''
  );
  if (set.length === 0) return null;
  return (
    `Heads up: trailhead is running on ${descriptor.label}, which has no ` +
    `subagent fan-out, so your models.* setting (${set.join(', ')}) cannot ` +
    `take effect here. Every activity runs inline on the one session model. ` +
    `The keys stay in .trailhead/config.json and apply again on Claude Code.`
  );
}

// --- Helper: updateNotice -----------------------------------------------------
// The one-line update notice the engine surfaces at session start on a host
// WITHOUT a hook bus (no SessionStart check-update hook, no statusline flag):
// there the engine runs the throttled check inline and shows this. Pure: given
// the host and a parsed update-check cache object, returns the notice string,
// or null when nothing should be shown (the host has a hook bus, or no update
// is available). Keying on hookBus === 'none' means it never fires on a host
// that already notifies via the hook + statusline (no double-notify). The
// caller owns the cache I/O and throttling, mirroring modelsCollapseNotice.
function updateNotice(host, cache) {
  const descriptor = resolveHost(host);
  if (descriptor.axes.hookBus !== 'none') return null;
  if (!cache || typeof cache !== 'object' || !cache.updateAvailable) return null;
  const latest = String(cache.latest || '').trim();
  const installed = String(cache.installed || '').trim();
  const ver = latest ? ` ${latest}` : '';
  const from = installed ? ` (you have ${installed})` : '';
  return `Heads up: trailhead${ver} is available${from}. Run /trailhead:update to install it.`;
}

// --- Runtime host detection --------------------------------------------------
// Mirrors GSD's host-runtime-detection.cjs in shape: a short signal ladder,
// wrapped so it NEVER throws. This is what lets the engine's inline rules
// (plain text executed by the Claude Agent tool, not compiled code) figure
// out which host they're actually running under at runtime, independent of
// whatever the installer laid down at install-time.

// Codex sandbox env vars set by the shell tool / Seatbelt child-process spawn.
// Best-effort: absent under sandbox_mode = "danger-full-access", so this
// signal degrades to the next rung when unset rather than being load-bearing.
const CODEX_SESSION_ENV_SIGNALS = Object.freeze(['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']);
const CODEX_HOME_ENV = 'CODEX_HOME';
const CODEX_CONFIG_MARKER = 'config.toml';

// detectHost never throws: every read here (including `deps.env` itself,
// which a caller could hand in as a throwing Proxy) is wrapped in a single
// guarded region that degrades to 'claude' on any unexpected error. A
// detection helper that can throw is worse than useless in an inline rule
// that has no try/catch of its own around it: the whole point is that
// callers can invoke this without defensive code of their own.
function detectHost(deps = {}) {
  try {
    const env = deps.env || process.env;
    const fileExists = deps.fileExists || ((p) => fs.existsSync(p));

    for (const key of CODEX_SESSION_ENV_SIGNALS) {
      const value = env[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return 'codex';
      }
    }

    const codexHome = env[CODEX_HOME_ENV];
    if (typeof codexHome === 'string' && codexHome.trim() !== '') {
      try {
        if (fileExists(path.join(codexHome, CODEX_CONFIG_MARKER))) {
          return 'codex';
        }
      } catch {
        // Swallow probe failures (EACCES etc.) and fall through to claude.
      }
    }

    // The DEFAULT ~/.codex/config.toml is deliberately NEVER probed here.
    // Every machine that has ever run Codex has that file lying around, so
    // checking it unconditionally would misreport plain Claude Code sessions
    // as codex just because Codex was installed at some point. Only an
    // EXPLICITLY exported CODEX_HOME counts: that's the current session
    // designating a Codex root, not ambient machine history.
    return 'claude';
  } catch {
    return 'claude';
  }
}

module.exports = {
  AXES,
  HOSTS,
  getHost,
  configDirFor,
  hyphenateCommand,
  emitsAgentToml,
  degradations,
  modelsCollapseNotice,
  updateNotice,
  detectHost,
  CODEX_SESSION_ENV_SIGNALS,
  CODEX_HOME_ENV,
  CODEX_CONFIG_MARKER,
};
