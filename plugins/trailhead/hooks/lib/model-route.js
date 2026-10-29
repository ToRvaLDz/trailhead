'use strict';
// model-route.js: decide dove gira un'attivita' legata a una chiave models.*
// (inline nella sessione oppure dispatch a un subagent), per host. #323.
// Funzione pura route() piu' una CLI che carica la config effettiva (globale
// poi progetto, uniti da effectiveModels di model-defaults-review.js).
// Per la chiave grill, un valore non impostato segue models.plan (e su Codex
// models.codex.plan): non ha un default Balanced proprio. #323.
// Oggi lo usa solo Grilling (techniques/grilling.md, "Who runs a round");
// le altre chiavi seguono ancora la regola in prosa.
//
// CLI:
//   node model-route.js <key> --session <id completo|unknown> [--session-effort <e>]
//        [--host claude|codex] [--no-subagents] [<dir>]
// Stampa una riga JSON {"route","agent","model","alias","suggest","warning"}.
// Exit 2 (errore JSON su stderr, niente su stdout) se manca --session o e'
// vuoto, con un flag sconosciuto, un host o una chiave sconosciuti.

const fs = require('fs');
const path = require('path');
const mdr = require('./model-defaults-review.js');

const INLINE_VALUE = 'inherit session';
const UNKNOWN_SESSION = 'unknown'; // valore riservato: non e' mai uguale a un id
const HOSTS = ['claude', 'codex'];
const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

// Chiave -> nome dell'agent, per host. Su Codex i nomi sono quelli che la
// proiezione TOML emette (codexAgentTomlPlan); su Claude quelli sotto agents/.
const AGENT_OF = Object.freeze({
  claude: Object.freeze({
    plan: 'trailhead-plan',
    execute: 'trailhead-executor',
    research: 'trailhead-research',
    review: 'trailhead-code-review',
    debug: 'trailhead-debug',
    verify: 'trailhead-verify',
    'codebase-map': 'trailhead-codebase-map',
    grill: 'trailhead-grill',
  }),
  codex: Object.freeze({
    plan: 'trailhead-plan',
    execute: 'trailhead-execute',
    research: 'trailhead-research',
    review: 'trailhead-review',
    debug: 'trailhead-debug',
    verify: 'trailhead-verify',
    'codebase-map': 'trailhead-codebase-map',
    grill: 'trailhead-grill',
  }),
});

// Riga Balanced della tabella dei profili (configuration-reference.md); il
// test la tiene allineata alla tabella.
const BALANCED = Object.freeze({
  plan: 'strong',
  execute: 'standard',
  research: 'standard',
  review: 'standard',
  debug: 'standard',
  verify: 'standard',
  'codebase-map': 'fast',
  grill: 'strong',
});

// Famiglia (alias accettato da Agent su Claude Code) dell'id, o null.
function familyAlias(id) {
  if (typeof id !== 'string') return null;
  return ALIASES.find((a) => id.toLowerCase().includes(a)) || null;
}

// Id dei tier dell'host dall'entry corrente di model-defaults.json.
function loadTierIds(host) {
  const current = mdr.currentEntry(mdr.loadData());
  return (current && current[host]) || {};
}

// Toglie un suffisso finale `[...]` (es. la finestra di contesto `[1m]`): lo
// stesso modello con o senza suffisso resta lo stesso modello.
const stripSuffix = (id) => (typeof id === 'string' ? id.replace(/\[[^\]]*\]\s*$/, '').trim() : id);

const isUnset = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const result = (fields) => ({ route: 'inline', agent: null, model: null, alias: null, suggest: null, warning: null, ...fields });

// Grill non impostato segue plan (valore risolto di models.plan, o il default
// Balanced di plan): ritorna { raw, tierKey } per la chiave data.
function resolveRaw(source, key) {
  const own = source ? source[key] : undefined;
  if (key === 'grill' && isUnset(own)) return { raw: source ? source.plan : undefined, tierKey: 'plan' };
  return { raw: own, tierKey: key };
}

function routeClaude({ key, models, sessionModel, subagents, tierIds }) {
  const { raw, tierKey } = resolveRaw(models, key);
  if (typeof raw === 'string' && raw.trim() === INLINE_VALUE) return result({});
  const id = stripSuffix(isUnset(raw) ? (tierIds || {})[BALANCED[tierKey]] : raw);
  if (typeof id !== 'string' || id.trim() === '') return result({ warning: 'unknown-id' });
  const sameAsSession = sessionModel !== UNKNOWN_SESSION && id === sessionModel;

  if (subagents === false) {
    return result({ model: id, suggest: sameAsSession ? null : id });
  }
  if (sameAsSession) return result({ model: id });
  const alias = familyAlias(id);
  if (!alias) return result({ model: id, warning: 'unknown-id' });
  return result({ route: 'dispatch', agent: AGENT_OF.claude[key], model: id, alias });
}

function routeCodex({ key, models, sessionModel, sessionEffort, subagents }) {
  const codexModels = models && models.codex && typeof models.codex === 'object' && !Array.isArray(models.codex) ? models.codex : {};
  const { raw } = resolveRaw(codexModels, key);
  if (isUnset(raw) || raw === INLINE_VALUE) return result({});
  let pin = typeof raw === 'object' ? raw : { model: raw };
  if (typeof pin.model !== 'string' || pin.model.trim() === '') return result({});
  pin = { ...pin, model: stripSuffix(pin.model) };

  const sameModel = sessionModel !== UNKNOWN_SESSION && pin.model === sessionModel;
  if (subagents === false) return result({ model: pin.model, suggest: sameModel ? null : pin.model });
  // Solo il TOML proiettato onora model_reasoning_effort: a parita' di modello
  // si resta inline solo se non c'e' un effort pinnato, o se coincide con quello di sessione.
  if (sameModel) {
    if (!pin.effort) return result({ model: pin.model });
    if (sessionEffort && sessionEffort === pin.effort) return result({ model: pin.model });
  }
  return result({ route: 'dispatch', agent: AGENT_OF.codex[key], model: pin.model });
}

function route({ key, host, models, sessionModel, sessionEffort, subagents, tierIds } = {}) {
  if (!HOSTS.includes(host)) throw new Error(`unknown host: ${host}`);
  if (!Object.prototype.hasOwnProperty.call(AGENT_OF[host], key)) throw new Error(`unknown key: ${key}`);
  const args = { key, models, sessionModel: stripSuffix(sessionModel), sessionEffort, subagents, tierIds };
  return host === 'codex' ? routeCodex(args) : routeClaude(args);
}

// --- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { key: null, session: null, sessionEffort: null, host: null, subagents: true, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-subagents') {
      opts.subagents = false;
    } else if (a === '--session' || a === '--session-effort' || a === '--host') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      opts[a === '--session' ? 'session' : a === '--host' ? 'host' : 'sessionEffort'] = v;
      i++;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else if (opts.key === null) {
      opts.key = a;
    } else if (opts.dir === null) {
      opts.dir = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  if (!opts.key) throw new Error('a key is required');
  if (opts.session === null || opts.session.trim() === '') throw new Error('--session <full model id|unknown> is required');
  if (opts.host !== null && !HOSTS.includes(opts.host)) throw new Error(`unknown host: ${opts.host}`);
  return opts;
}

// Config effettiva: globale poi progetto (il progetto vince chiave per chiave).
function effectiveConfig(host, dir) {
  const layers = [{ layer: 'global', file: mdr.globalConfigFile(host), config: mdr.loadGlobalConfig(host) }];
  const projectRoot = mdr.findProjectRoot(dir);
  if (projectRoot) {
    const file = path.join(projectRoot, '.trailhead', 'config.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      layers.push({ layer: 'project', file, config: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} });
    } catch {
      /* config di progetto illeggibile: vale come assente */
    }
  }
  return mdr.effectiveModels(layers).config;
}

function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let out;
  try {
    const opts = parseArgs(argv);
    const host = opts.host || mdr.detectHost();
    const models = effectiveConfig(host, opts.dir || process.cwd()).models;
    out = route({
      key: opts.key,
      host,
      models,
      sessionModel: opts.session,
      sessionEffort: opts.sessionEffort,
      subagents: opts.subagents,
      tierIds: loadTierIds('claude'),
    });
  } catch (e) {
    stderr.write(`${JSON.stringify({ error: e.message })}\n`);
    return 2;
  }
  stdout.write(`${JSON.stringify({ route: out.route, agent: out.agent, model: out.model, alias: out.alias, suggest: out.suggest, warning: out.warning })}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { route, parseArgs, main, effectiveConfig, familyAlias, loadTierIds, AGENT_OF, BALANCED };
