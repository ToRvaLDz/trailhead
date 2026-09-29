'use strict';
// model-defaults-review.js: quando un aggiornamento sposta i default dei
// tier (plugins/trailhead/hooks/lib/model-defaults.json), offre la revisione
// dei models.* / models.codex.* pinnati che sono rimasti ai vecchi default.
// check() e' di sola lettura: non scrive mai l'ack, quindi ripropone la
// notice finche' qualcuno non chiama ack(cwd) (dopo che l'utente ha risposto
// a una delle tre scelte). Non lancia mai eccezioni dagli entry point
// pubblici: ogni funzione degrada a null/[]/false in caso di dato mancante
// o malformato. Entry point condiviso anche dagli host senza hook bus (CLI
// "check"/"ack" in fondo al file).

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'model-defaults.json');
const HOSTS = ['claude', 'codex'];
const TIERS = ['strong', 'standard', 'fast'];

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { schema: 1, history: [] };
  }
}

function currentEntry(data) {
  const history = (data && data.history) || [];
  return history[history.length - 1] || null;
}

// Confronto semver minimale: true se a < b. Ignora pre-release, tollera "v".
function semverLt(a, b) {
  const clean = (v) => String(v || '').replace(/^v/, '').split('-')[0];
  const pa = clean(a).split('.').map(Number);
  const pb = clean(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

// Trova il tier T a cui un id e' storicamente appartenuto per un host dato:
// T's default in una entry PIU' VECCHIA della corrente, oppure elencato nei
// supersedes[host][T] di una qualsiasi entry (corrente inclusa). Se piu'
// entry corrispondono, vince quella con indice piu' alto (piu' recente).
function findTier(data, host, id, current) {
  const history = data.history || [];
  let best = null; // { tier, index }
  history.forEach((entry, index) => {
    if (entry !== current && entry[host]) {
      for (const tier of TIERS) {
        if (entry[host][tier] === id) {
          if (!best || index > best.index) best = { tier, index };
        }
      }
    }
    if (entry.supersedes && entry.supersedes[host]) {
      for (const tier of TIERS) {
        const list = entry.supersedes[host][tier] || [];
        if (list.includes(id)) {
          if (!best || index > best.index) best = { tier, index };
        }
      }
    }
  });
  return best ? best.tier : null;
}

function isSkippable(id) {
  return !id || typeof id !== 'string' || id.trim() === '' || id === 'inherit session';
}

// Valuta un singolo pin (id) per un host e ritorna { from, to } se stale,
// null altrimenti (id sconosciuto o gia' allineato al default corrente).
function evaluatePin(data, host, id, current) {
  if (isSkippable(id)) return null;
  const tier = findTier(data, host, id, current);
  if (!tier) return null;
  const to = current[host][tier];
  if (to === id) return null;
  return { from: id, to };
}

function stalePins(config, data) {
  const out = [];
  const current = currentEntry(data);
  if (!current) return out;
  const models = (config && config.models) || {};

  for (const key of Object.keys(models)) {
    if (key === 'codex') continue;
    const result = evaluatePin(data, 'claude', models[key], current);
    if (result) out.push({ key: `models.${key}`, from: result.from, to: result.to });
  }

  // Un models.codex malformato (non un oggetto piano) non produce pin: come
  // se fosse assente, invece di iterare i suoi indici/caratteri.
  const codex = isPlainObject(models.codex) ? models.codex : {};
  for (const key of Object.keys(codex)) {
    const raw = codex[key];
    const id = raw && typeof raw === 'object' ? raw.model : raw;
    const result = evaluatePin(data, 'codex', id, current);
    if (result) out.push({ key: `models.codex.${key}`, from: result.from, to: result.to });
  }

  return out;
}

// Ritorna una NUOVA config con i pin stale aggiornati; non muta l'input.
function applyUpdate(config, stale) {
  const next = { ...config, models: { ...((config && config.models) || {}) } };
  if (next.models.codex) next.models.codex = { ...next.models.codex };

  for (const s of stale) {
    if (s.key.startsWith('models.codex.')) {
      const k = s.key.slice('models.codex.'.length);
      const cur = next.models.codex[k];
      next.models.codex[k] = cur && typeof cur === 'object' ? { ...cur, model: s.to } : s.to;
    } else {
      const k = s.key.slice('models.'.length);
      next.models[k] = s.to;
    }
  }
  return next;
}

// Unisce piu' layer di config (dal piu' generico al piu' specifico, es.
// [global, project]) in una config effettiva pura: nessun input viene
// mutato. La precedenza e' per PRESENZA della chiave, mai per verita' del
// valore: un layer piu' specifico che imposta una chiave (anche a null, ''
// o "inherit session") vince sempre, e il valore del layer sotto non
// riaffiora mai. models.codex e' unito chiave per chiave solo quando sia
// l'accumulo corrente sia il valore in arrivo sono oggetti piani; altrimenti
// il valore del layer piu' specifico rimpiazza l'intero models.codex (un
// models.codex malformato nel progetto produce quindi zero pin codex, non
// un fallback al globale). Ogni layer il cui `models` non e' un oggetto
// piano (null, array, stringa) non contribuisce, come se fosse assente.
// Ritorna { config, sources }, dove sources mappa ogni chiave vincente
// (es. "models.plan", "models.codex.plan") a { layer, file } di chi l'ha
// decisa, cosi' la notice puo' stampare il path reale.
function effectiveModels(layers) {
  let models = {};
  let codex; // undefined finche' nessun layer tocca models.codex
  const sources = {};

  for (const layer of layers || []) {
    const cfgModels = layer && layer.config && isPlainObject(layer.config.models) ? layer.config.models : null;
    if (!cfgModels) continue;

    for (const key of Object.keys(cfgModels)) {
      if (key === 'codex') continue;
      models = { ...models, [key]: cfgModels[key] };
      sources[`models.${key}`] = { layer: layer.layer, file: layer.file };
    }

    if (Object.prototype.hasOwnProperty.call(cfgModels, 'codex')) {
      const incoming = cfgModels.codex;
      if (isPlainObject(incoming) && isPlainObject(codex)) {
        for (const k of Object.keys(incoming)) {
          codex = { ...codex, [k]: incoming[k] };
          sources[`models.codex.${k}`] = { layer: layer.layer, file: layer.file };
        }
      } else {
        for (const k of Object.keys(sources)) {
          if (k.startsWith('models.codex.')) delete sources[k];
        }
        codex = isPlainObject(incoming) ? { ...incoming } : incoming;
        if (isPlainObject(codex)) {
          for (const k of Object.keys(codex)) {
            sources[`models.codex.${k}`] = { layer: layer.layer, file: layer.file };
          }
        }
      }
    }
  }

  const outModels = { ...models };
  if (codex !== undefined) outModels.codex = codex;
  return { config: { models: outModels }, sources };
}

function reviewOffer({ config, data, ack, sources }) {
  const current = currentEntry(data);
  if (!current) return null;
  const stale = stalePins(config, data).map((s) => {
    const source = sources && sources[s.key];
    return source ? { ...s, source } : s;
  });
  if (!stale.length) return null;
  if (ack && !semverLt(ack, current.since)) return null;
  return { since: current.since, stale, notice: reviewNotice(stale, current.since) };
}

function sourceSuffix(source) {
  if (!source) return ' (new default)';
  const layerName = source.layer === 'global' ? 'the global config' : 'the project config';
  return ` (new default; from ${layerName}, ${source.file})`;
}

function reviewNotice(stale, since) {
  const lines = stale.map((s) => `- ${s.key}: ${s.from} -> ${s.to}${sourceSuffix(s.source)}`);
  return [
    `trailhead's default models changed in ${since}. The following pinned model(s) are older than the new default:`,
    ...lines,
    '',
    'Offer the user, once, without blocking their current request, three choices:',
    '1) update those keys to the new defaults (edit each key in the config file it comes from, with exactly the values above; keep any codex effort unchanged),',
    '2) keep them as they are (nothing to do; trailhead will not ask again for these defaults once acknowledged),',
    '3) open /trailhead:config to pick per key.',
    'This offer reappears every time it is checked until acknowledged: run the ack instruction below only after the user has picked one of the three choices above.',
  ].join('\n');
}

// Paragrafo con l'istruzione pronta all'uso per acquisire l'ack, appesa alla
// notice da check(). Nomina il path assoluto di questo lib e la root (la
// root del progetto trovata, oppure il cwd nel caso solo-globale), cosi'
// l'agente puo' eseguirla cosi' com'e'.
function ackInstruction(root) {
  return `Once the user has answered, run: node "${__filename}" ack "${root}"`;
}

// --- I/O ---------------------------------------------------------------
const ACK_FILE = path.join('.trailhead', 'model-defaults-ack');
const CONFIG_FILE = path.join('.trailhead', 'config.json');

// Dir base della config globale: stessa risoluzione di trailhead-check-update.js.
function globalConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function globalConfigFile() {
  return path.join(globalConfigDir(), 'trailhead', 'config.json');
}

// L'ack globale vive accanto al config.json globale, senza nidificare
// ".trailhead" (che e' una convenzione solo di progetto).
function globalAckFile() {
  return path.join(globalConfigDir(), 'trailhead', 'model-defaults-ack');
}

// Mancante o malformato -> {}: non deve mai bloccare la review di progetto.
function loadGlobalConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(globalConfigFile(), 'utf8'));
    return isPlainObject(raw) ? raw : {};
  } catch {
    return {};
  }
}

function findProjectRoot(cwd) {
  let dir = path.resolve(cwd || '.');
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readAckFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeAckFile(file, since) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, since);
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* mai far fallire il chiamante per un ack non scrivibile */
  }
}

function readAck(root) {
  return readAckFile(path.join(root, ACK_FILE));
}

function writeAck(root, since) {
  writeAckFile(path.join(root, ACK_FILE), since);
}

// Di sola lettura: non scrive mai l'ack. Ripropone la stessa notice finche'
// non arriva un ack esplicito via ack(cwd). Valuta i pin EFFETTIVI: la
// config globale unita sotto quella di progetto (progetto vince chiave per
// chiave); senza un progetto sopra cwd, valuta la sola config globale.
function check(cwd) {
  try {
    const resolvedCwd = path.resolve(cwd || '.');
    const root = findProjectRoot(cwd);
    const data = loadData();
    const globalFile = globalConfigFile();
    const globalLayer = { layer: 'global', file: globalFile, config: loadGlobalConfig() };

    if (root) {
      let projectConfig;
      try {
        projectConfig = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
      } catch {
        return null;
      }
      const projectLayer = {
        layer: 'project',
        file: path.join(root, CONFIG_FILE),
        config: isPlainObject(projectConfig) ? projectConfig : {},
      };
      const { config, sources } = effectiveModels([globalLayer, projectLayer]);
      const ack = readAck(root);
      const offer = reviewOffer({ config, data, ack, sources });
      if (!offer) return null;
      return `${offer.notice}\n${ackInstruction(root)}`;
    }

    // Nessun progetto sopra cwd: valuta la sola config globale, se esiste.
    if (!fs.existsSync(globalFile)) return null;
    const { config, sources } = effectiveModels([globalLayer]);
    const ack = readAckFile(globalAckFile());
    const offer = reviewOffer({ config, data, ack, sources });
    if (!offer) return null;
    return `${offer.notice}\n${ackInstruction(resolvedCwd)}`;
  } catch {
    return null;
  }
}

// Scrive l'ack, con il "since" corrente dei default. Va chiamata SOLO dopo
// che l'utente ha risposto a una delle tre scelte della notice. Progetto
// trovato sopra cwd -> ack di progetto; altrimenti, se esiste una config
// globale -> ack globale. True se un target e' stato trovato e la scrittura
// tentata (un fallimento silenzioso non e' riportato, comportamento
// invariato); false se nessun target esiste. Non lancia mai eccezioni.
function ack(cwd) {
  try {
    const root = findProjectRoot(cwd);
    const data = loadData();
    const current = currentEntry(data);
    if (!current) return false;
    if (root) {
      writeAck(root, current.since);
      return true;
    }
    if (fs.existsSync(globalConfigFile())) {
      writeAckFile(globalAckFile(), current.since);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  loadData,
  currentEntry,
  stalePins,
  applyUpdate,
  semverLt,
  effectiveModels,
  reviewOffer,
  reviewNotice,
  findProjectRoot,
  globalConfigDir,
  globalConfigFile,
  globalAckFile,
  readAckFile,
  writeAckFile,
  readAck,
  writeAck,
  check,
  ack,
};

// CLI: entry point condiviso per gli host senza hook bus.
if (require.main === module) {
  const [cmd, cwdArg] = process.argv.slice(2);
  try {
    if (cmd === 'check') {
      const notice = check(cwdArg || process.cwd());
      if (notice) process.stdout.write(notice + '\n');
    } else if (cmd === 'ack') {
      ack(cwdArg || process.cwd());
    }
  } catch {
    /* mai fallire da CLI */
  }
  process.exit(0);
}
