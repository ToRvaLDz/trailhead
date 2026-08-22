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

// The Codex support floor (decision #27): multi_agent (the binding constraint)
// is stable at 0.145.0, so trailhead's single codex descriptor (subagentToolkit
// 'full') is only projected onto a Codex at or above this version.
const CODEX_MIN_VERSION = '0.145.0';

// --- Axis 1: the 3 closed vocabularies (decision #17) ---------------------
// Each axis is a closed set of values a host can take. Closed on purpose:
// a new value here is a design decision (a new ticket), not a typo away.
const AXES = Object.freeze({
  // How a host surfaces trailhead's commands to the user.
  //   'slash-file'    Claude: namespaced slash-command files under commands/trailhead/*.md
  //   'hyphen-prompt' Codex:  flat, hyphenated prompt files (trailhead-work.md, etc.)
  //   'skill'         Codex:  one native skill folder skills/trailhead/, invoked `$trailhead <verb>`
  commandSurface: Object.freeze(['slash-file', 'hyphen-prompt', 'skill']),
  // Whether the host has a dedicated subagent/Task-fanout toolkit.
  //   'full' Claude: the Agent tool; Codex: the native multi_agent tools
  //          (spawn_agent/..., on by default at the supported floor)
  //   'none' a host with no such toolkit; everything the engine needs runs inline
  subagentToolkit: Object.freeze(['full', 'none']),
  // Whether the host has a lifecycle hook bus (PreToolUse/PostToolUse/Stop/...).
  //   'host' Claude: native hooks; Codex: the `features.hooks` lifecycle bus
  //   'none' a host with no hook bus (no supported host today, kept for future hosts)
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
    // Whether this host can run a subagent on a trailhead `models.*` value (a
    // Claude model id). Claude Code's subagents do, so the per-activity model
    // split takes effect here. Like emitsAgentToml, an explicit data flag, not
    // derived from an axis.
    honorsModelKeys: true,
    hooks: Object.freeze({ bus: 'host' }),
  }),
  codex: Object.freeze({
    label: 'Codex',
    configDirEnv: 'CODEX_HOME',
    configDirDefault: '.codex',
    axes: Object.freeze({
      commandSurface: 'skill',
      subagentToolkit: 'full',
      hookBus: 'host',
    }),
    // A single native Codex skill folder, invoked `$trailhead <verb>`.
    commands: Object.freeze({
      layout: 'native-skill',
      dir: 'skills/trailhead',
    }),
    // Also explicit, also independent from the axis: Codex's native multi_agent
    // tools are on by default and need NO manifest for base fan-out, but when
    // models.codex.* is set per technique, the installer projects those pins
    // into per-technique agents/*.toml files under ~/.codex/agents/ and turns
    // on features.multi_agent_v2 so Codex honours them.
    emitsAgentToml: true,
    // Whether Codex can run a subagent on a trailhead `models.*` value: NO. Its
    // subagent model registry is OpenAI-only, so a Claude id (e.g. claude-sonnet-5)
    // cannot run; subagents inherit the one session model. Hence models.* still
    // collapses here even though fan-out is available.
    honorsModelKeys: false,
    // Codex now has a native hook bus (stable at the install floor #27), so
    // the guardrails (secret-guard, commit-guard, etc.) run as real Codex
    // hooks, projected into ~/.codex/hooks.json by the installer. The
    // models.* collapse is the only remaining Codex degradation.
    hooks: Object.freeze({ bus: 'host' }),
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
  }

  // Independent of fan-out: a host whose subagents can't run a trailhead
  // models.* value (a Claude id) loses the per-activity model split even when
  // fan-out itself is available (e.g. Codex, OpenAI-only subagent registry).
  if (!descriptor.honorsModelKeys) {
    entries.push({
      from: 'per-activity model split (models.*)',
      to: 'collapses to a single session model (recover the split with models.codex.*)',
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
// configured on a host that cannot honour it (honorsModelKeys === false): its
// subagents run on the host's own model, so the per-activity split collapses to
// the single session model (see degradations()), UNLESS the host has a parallel
// native namespace configured. On Codex that namespace is models.codex.* (OpenAI
// model ids): once any models.codex.* key is set, the notice stays silent (the
// user has already opted into the honoured namespace there) and only reworded
// to point at models.codex.* while a stray Claude-id models.* key is set and
// models.codex.* is still empty. Keyed on honorsModelKeys, NOT on
// subagentToolkit: a host can have fan-out yet still be unable to run a
// subagent on a Claude models.* id (Codex). Pure: returns the notice string, or
// null when there is nothing to say (the host honours the keys, no models.* is
// set, or models.codex.* is already set). The caller owns the "one-time"
// bookkeeping (a marker file) and how the string is shown, so this stays pure
// and trivially testable.
function modelsCollapseNotice(host, config) {
  const descriptor = resolveHost(host);
  if (descriptor.honorsModelKeys) return null;
  const models = config && typeof config === 'object' ? config.models : null;
  if (!models || typeof models !== 'object') return null;

  const codexModels = models.codex && typeof models.codex === 'object' ? models.codex : null;
  const codexSet = codexModels
    ? Object.keys(codexModels).filter(
        (k) => codexModels[k] != null && String(codexModels[k]).trim() !== ''
      )
    : [];
  if (codexSet.length > 0) return null;

  // Exclude the literal 'codex' key: models.codex is a nested object, and
  // String({}).trim() is the non-empty "[object Object]", so without this
  // exclusion a lone models.codex.* namespace (with no Claude ids set) would
  // mis-count as a set Claude key and mis-fire the notice below.
  const set = Object.keys(models).filter(
    (k) => k !== 'codex' && models[k] != null && String(models[k]).trim() !== ''
  );
  if (set.length === 0) return null;

  return (
    `Heads up: trailhead is running on ${descriptor.label}, whose subagents ` +
    `run on its own OpenAI models. Your models.* setting (${set.join(', ')}) is a ` +
    `Claude model id and cannot take effect here: every activity's subagent still ` +
    `inherits the one session model. Set models.codex.* (OpenAI model ids) instead ` +
    `to get the per-activity split on ${descriptor.label}. The models.* keys stay ` +
    `in .trailhead/config.json and apply again on Claude Code.`
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

// --- Codex version floor gate (decision #27) --------------------------------
// The install-time enforcement of CODEX_MIN_VERSION. Pure and never-throwing:
// the installer runs `codex --version` and hands the raw output here; this
// decides whether to project. Below the floor the multi_agent tools the
// adapter's §D relies on are not stable, so the installer refuses (fail below
// floor). An undeterminable version (codex absent, or unparseable output)
// fails OPEN with a warning: a gate can't prove a violation it can't read, and
// a false block would wrongly stop a valid install.

// Extract a dotted-numeric [major, minor, patch] from any version string
// ("codex-cli 0.149.0", "0.145.0-alpha.1", "0.149.0"), or null when absent.
function parseVersion(str) {
  const m = String(str == null ? '' : str).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// -1 / 0 / 1 comparison of two [maj,min,patch] triples.
function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Verdict the installer acts on. Given the raw `codex --version` output (or
// null/'' when the probe failed) and the floor, returns { ok, proceed,
// undetermined, version, floor, message }. Never throws.
//   at/above floor      -> { ok:true,  proceed:true,  undetermined:false, message:null }
//   parseable & below   -> { ok:false, proceed:false, undetermined:false, message:<refuse> }
//   unparseable/absent   -> { ok:true,  proceed:true,  undetermined:true,  message:<warn> }
function codexVersionGate(versionOutput, floor = CODEX_MIN_VERSION) {
  const got = parseVersion(versionOutput);
  if (!got) {
    return {
      ok: true, proceed: true, undetermined: true, version: null, floor,
      message: `Could not determine the Codex version (\`codex --version\` unavailable or unrecognised). trailhead needs Codex >= ${floor} for its multi_agent fan-out; proceeding, but the subagent features will not work on an older Codex.`,
    };
  }
  // A caller-supplied floor that can't be parsed can't gate anything: treat it
  // as no constraint (proceed) rather than dereferencing null in compareVersion,
  // honouring the "never throws" contract. The default floor is always parseable.
  const floorV = parseVersion(floor);
  if (floorV && compareVersion(got, floorV) < 0) {
    return {
      ok: false, proceed: false, undetermined: false, version: got.join('.'), floor,
      message: `Codex ${got.join('.')} is below trailhead's floor of ${floor}: its multi_agent subagent tools are not stable, so trailhead will not install. Upgrade Codex to >= ${floor} and re-run.`,
    };
  }
  return { ok: true, proceed: true, undetermined: false, version: got.join('.'), floor, message: null };
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
  codexVersionGate,
  parseVersion,
  detectHost,
  CODEX_MIN_VERSION,
  CODEX_SESSION_ENV_SIGNALS,
  CODEX_HOME_ENV,
  CODEX_CONFIG_MARKER,
};
