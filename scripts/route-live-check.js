#!/usr/bin/env node
// Verifica live e ripetibile del routing del motore (#325). Per ognuno degli 8
// step (plan, execute, fix, review, verify, research, debug, codebase-map) lancia
// `claude -p` headless su una sessione Sonnet, in un progetto scratch la cui
// config fissa ogni chiave models.*, e controlla dallo stream-json che:
//   - config D (tutte le chiavi opus): l'helper model-route.js <chiave> venga
//     chiamato, poi parta lo spawn dell'agent dello step con model `opus`;
//   - config I (tutte le chiavi sonnet = sessione): l'helper venga chiamato,
//     nessuno spawn, e compaia il marker `INLINE <step>`.
// Spende chiamate al modello: NON e' un *.test.js e non gira in `npm test`.
// Il parser e la valutazione sono funzioni pure (testate offline da
// route-live-check.test.js).
//
// Uso: node scripts/route-live-check.js [--steps a,b] [--configs D,I]
// Exit 0 se tutto PASS, 1 se qualche FAIL, 2 se il preflight (CLI/auth) fallisce.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(REPO, 'plugins', 'trailhead');
const SKILLS_DIR = path.join(PLUGIN_DIR, 'skills');
const SESSION_MODEL = 'claude-sonnet-5-5';
const RUN_TIMEOUT_MS = 300000;
const MAX_TURNS = '12';

const ENGINES = 'trailhead-work/references/ticket-engines.md';
// step -> chiave dell'helper, agent atteso, doc da seguire. helperAgent: l'agent
// che l'helper nomina quando differisce da quello spawnato (fix spawna trailhead-fix
// al posto dell'executor restituito).
const STEPS = Object.freeze({
  plan: { key: 'plan', agent: 'trailhead-plan', doc: ENGINES, where: 'the build Plan step (step 2)' },
  execute: { key: 'execute', agent: 'trailhead-executor', doc: ENGINES, where: 'the build Execute step, its Dispatch bullet' },
  fix: { key: 'execute', agent: 'trailhead-fix', helperAgent: 'trailhead-executor', doc: ENGINES, where: 'the bug Fix step, its Dispatch bullet' },
  review: { key: 'review', agent: 'trailhead-code-review', doc: '_shared/techniques/code-review.md', where: 'the Code review technique' },
  verify: { key: 'verify', agent: 'trailhead-verify', doc: '_shared/techniques/verify.md', where: 'the Goal-backward verification technique' },
  research: { key: 'research', agent: 'trailhead-research', doc: '_shared/techniques/research.md', where: 'the Research technique' },
  debug: { key: 'debug', agent: 'trailhead-debug', doc: ENGINES, where: 'the bug Diagnose step (step 2)' },
  'codebase-map': { key: 'codebase-map', agent: 'trailhead-codebase-map', doc: '_shared/techniques/codebase-map.md', where: 'the Codebase map technique' },
});

const CONFIGS = Object.freeze({
  D: { model: 'claude-opus-5-5', alias: 'opus' },
  I: { model: 'claude-sonnet-5-5', alias: null },
});
const MODEL_KEYS = ['plan', 'execute', 'research', 'review', 'debug', 'verify', 'codebase-map', 'grill'];
const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const AUTH_RE = /invalid api key|please run \/login|not logged in|authentication|unauthorized|\b401\b|credit balance/i;

// Config del progetto scratch: ogni chiave fissata, cosi' la config globale reale non filtra.
function projectConfig(model) {
  const models = {};
  for (const k of MODEL_KEYS) models[k] = model;
  return { ticket: { language: 'en' }, models };
}

function buildPrompt(step, projectRoot, skillsDir) {
  const s = STEPS[step];
  const doc = path.join(skillsDir, s.doc);
  return [
    `Live routing check for the trailhead engine step "${step}".`,
    `Read ${doc} and follow ${s.where}, starting with its routing gate.`,
    `Project root to pass to the helper: ${projectRoot}`,
    `The plugin's hooks dir (for <hooks>) is ${path.join(skillsDir, '..', 'hooks')} and the skills dir is ${skillsDir}.`,
    'Stub ticket #1: "Add a greeting function to src/greet.js" (a build ticket; for fix/debug treat it as a bug "greet() throws on empty input").',
    'Stop right after the dispatch decision. Do not write to any tracker, do not run gh, do not edit any file, do not do the step\'s real work.',
    `If the route is dispatch: spawn the agent the route names, with the route's model override, and a one-line prompt "Routing check only: reply OK and stop." Then stop.`,
    `If the route is inline: do not do the work; print the single line "INLINE ${step}" and stop.`,
  ].join('\n');
}

// Testo di un tool_result: stringa oppure array di blocchi {type:'text', text}.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

// L'helper stampa una riga JSON: prende l'ultima riga che e' un oggetto con `route`.
function helperJson(body) {
  const lines = String(body).split('\n').map((l) => l.trim()).filter(Boolean).reverse();
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object' && typeof o.route === 'string') return o;
    } catch { /* non JSON */ }
  }
  return null;
}

// Parser puro dello stream-json: eventi in ordine di arrivo. Le chiamate
// all'helper sono correlate al loro tool_result per tool_use_id.
function parseStream(text) {
  const out = { helperCalls: [], spawns: [], inlineMarkers: [], authError: false, resultError: null, order: 0 };
  const byId = new Map();
  for (const raw of String(text).split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        const order = out.order++;
        if (block.type === 'tool_use' && block.name === 'Bash') {
          const cmd = block.input && typeof block.input.command === 'string' ? block.input.command : '';
          const m = cmd.match(/\bnode\s+\S*model-route\.js\s+([a-z][a-z-]*)(?=\s|$)/);
          if (m) {
            // --session deve avere un valore non vuoto che sembri un id modello (non un flag ne' un path).
            const sm = cmd.match(/--session\s+(\S+)/);
            const session = sm && /^[A-Za-z0-9][\w.\-\[\]]*$/.test(sm[1]) ? sm[1] : null;
            const call = { key: m[1], command: cmd, order, id: block.id || null, session, json: null, error: null, hasResult: false };
            out.helperCalls.push(call);
            if (call.id) byId.set(call.id, call);
          }
        } else if (block.type === 'tool_use' && SPAWN_TOOLS.has(block.name)) {
          const inp = block.input || {};
          out.spawns.push({ tool: block.name, subagentType: inp.subagent_type || '', model: inp.model || null, order });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          for (const m of block.text.matchAll(/^\s*INLINE ([a-z-]+)\s*$/gm)) out.inlineMarkers.push(m[1]);
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type !== 'tool_result') continue;
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        const body = resultText(block.content);
        call.hasResult = true;
        call.json = helperJson(body);
        if (!call.json) call.error = body.trim().slice(0, 300) || 'empty result';
      }
    } else if (ev.type === 'result' && ev.is_error) {
      out.resultError = String(ev.result || ev.subtype || 'error');
      if (AUTH_RE.test(out.resultError)) out.authError = true;
    } else if (ev.type === 'error') {
      const msg = String(ev.error || ev.message || '');
      out.resultError = out.resultError || msg;
      if (AUTH_RE.test(msg)) out.authError = true;
    }
  }
  return out;
}

// Valutazione pura: { pass, reason } per (step, config) su uno stream gia' parsato.
function evaluate(step, config, parsed) {
  const s = STEPS[step];
  const c = CONFIGS[config];
  if (parsed.authError) return { pass: false, reason: `auth/CLI error, not a routing result: ${parsed.resultError}` };
  const helper = parsed.helperCalls.find((h) => h.key === s.key);
  if (!helper) {
    const seen = parsed.helperCalls.map((h) => h.key).join(',') || 'none';
    return { pass: false, reason: `no model-route.js ${s.key} call (helper keys seen: ${seen})` };
  }
  if (!helper.session) return { pass: false, reason: 'the helper call has no --session value' };
  if (!helper.hasResult) return { pass: false, reason: 'the helper call has no tool_result in the stream' };
  if (!helper.json) return { pass: false, reason: `the helper failed or printed no JSON: ${helper.error}` };
  const wantRoute = config === 'D' ? 'dispatch' : 'inline';
  if (helper.json.route !== wantRoute) return { pass: false, reason: `helper route is ${helper.json.route}, expected ${wantRoute}` };
  const agentOk = (t) => t === s.agent || t.endsWith(`:${s.agent}`);
  if (config === 'D') {
    const wantHelperAgent = s.helperAgent || s.agent;
    if (helper.json.agent !== wantHelperAgent) return { pass: false, reason: `helper agent is ${helper.json.agent}, expected ${wantHelperAgent}` };
    if (helper.json.alias !== c.alias) return { pass: false, reason: `helper alias is ${helper.json.alias}, expected ${c.alias}` };
    const sp = parsed.spawns.find((x) => agentOk(x.subagentType));
    if (!sp) return { pass: false, reason: `no spawn of ${s.agent} (spawns: ${parsed.spawns.map((x) => x.subagentType).join(',') || 'none'})` };
    if (sp.order < helper.order) return { pass: false, reason: 'the spawn came before the helper call' };
    if (sp.model !== helper.json.alias) return { pass: false, reason: `spawn model is ${sp.model}, helper alias is ${helper.json.alias}` };
    return { pass: true, reason: `helper ${s.key} dispatch ${helper.json.agent}, spawn ${sp.subagentType} model ${sp.model}` };
  }
  if (parsed.spawns.length > 0) return { pass: false, reason: `unexpected spawn: ${parsed.spawns.map((x) => x.subagentType).join(',')}` };
  if (!parsed.inlineMarkers.includes(step)) return { pass: false, reason: `no INLINE ${step} marker` };
  return { pass: true, reason: `helper ${s.key}, no spawn, INLINE ${step}` };
}

// --- Parte con effetti (non esercitata dal test offline) -------------------------------
function claudeArgs(extra) {
  return ['-p', ...extra];
}

function preflight() {
  const r = spawnSync('claude', claudeArgs(['Reply with the single word OK.', '--model', SESSION_MODEL, '--output-format', 'json', '--max-turns', '1']),
    { encoding: 'utf8', timeout: 120000 });
  if (r.error) return `claude CLI not runnable: ${r.error.message}`;
  const body = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.status !== 0 || AUTH_RE.test(body)) return `preflight failed (exit ${r.status}): ${body.trim().slice(0, 300)}`;
  return null;
}

function makeProject(model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-route-'));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.trailhead', 'config.json'), JSON.stringify(projectConfig(model), null, 2));
  return dir;
}

// Lancia una run e ferma il processo appena vede uno spawn (risparmia chiamate).
function runClaude(step, projectRoot) {
  return new Promise((resolve) => {
    const args = claudeArgs([buildPrompt(step, projectRoot, SKILLS_DIR),
      '--plugin-dir', PLUGIN_DIR, '--model', SESSION_MODEL,
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions', '--max-turns', MAX_TURNS]);
    const child = spawn('claude', args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let buf = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      buf += d;
      if (!killed && parseStream(buf).spawns.length > 0) { killed = true; child.kill('SIGTERM'); }
    });
    // stderr resta fuori dallo stream parsato: si stampa solo su FAIL.
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => { clearTimeout(timer); resolve({ stdout: buf, stderr: err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ stdout: '', stderr: e.message }); });
  });
}

function parseArgs(argv) {
  const opts = { steps: Object.keys(STEPS), configs: Object.keys(CONFIGS) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (a === '--steps') opts.steps = list(argv[++i]);
    else if (a === '--configs') opts.configs = list(argv[++i]);
    else throw new Error(`unknown flag ${a}`);
  }
  for (const s of opts.steps) if (!STEPS[s]) throw new Error(`unknown step ${s} (known: ${Object.keys(STEPS).join(', ')})`);
  for (const c of opts.configs) if (!CONFIGS[c]) throw new Error(`unknown config ${c} (known: ${Object.keys(CONFIGS).join(', ')})`);
  return opts;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const pre = preflight();
  if (pre) { console.error(pre); process.exit(2); }
  let failed = 0;
  for (const config of opts.configs) {
    const dir = makeProject(CONFIGS[config].model);
    try {
      for (const step of opts.steps) {
        const run = await runClaude(step, dir);
        const r = evaluate(step, config, parseStream(run.stdout));
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  config ${config}  ${step}: ${r.reason}`);
        if (!r.pass && run.stderr.trim()) console.log(`  stderr: ${run.stderr.trim().slice(0, 500)}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { STEPS, CONFIGS, MODEL_KEYS, projectConfig, buildPrompt, parseStream, evaluate };

if (require.main === module) main();
