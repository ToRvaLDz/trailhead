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
// step -> chiave dell'helper, agent atteso, doc da seguire.
const STEPS = Object.freeze({
  plan: { key: 'plan', agent: 'trailhead-plan', doc: ENGINES, where: 'the build Plan step (step 2)' },
  execute: { key: 'execute', agent: 'trailhead-executor', doc: ENGINES, where: 'the build Execute step, its Dispatch bullet' },
  fix: { key: 'execute', agent: 'trailhead-fix', doc: ENGINES, where: 'the bug Fix step, its Dispatch bullet' },
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

// Parser puro dello stream-json: eventi in ordine di arrivo.
function parseStream(text) {
  const out = { helperCalls: [], spawns: [], inlineMarkers: [], authError: false, resultError: null, order: 0 };
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
          if (m) out.helperCalls.push({ key: m[1], command: cmd, order });
        } else if (block.type === 'tool_use' && SPAWN_TOOLS.has(block.name)) {
          const inp = block.input || {};
          out.spawns.push({ tool: block.name, subagentType: inp.subagent_type || '', model: inp.model || null, order });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          for (const m of block.text.matchAll(/^\s*INLINE ([a-z-]+)\s*$/gm)) out.inlineMarkers.push(m[1]);
        }
      }
    } else if (ev.type === 'result' && ev.is_error) {
      out.resultError = String(ev.result || ev.subtype || 'error');
      if (AUTH_RE.test(out.resultError)) out.authError = true;
    } else if (ev.type === 'error' || (ev.error && AUTH_RE.test(String(ev.error)))) {
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
  const agentOk = (t) => t === s.agent || t.endsWith(`:${s.agent}`);
  if (config === 'D') {
    const sp = parsed.spawns.find((x) => agentOk(x.subagentType));
    if (!sp) return { pass: false, reason: `no spawn of ${s.agent} (spawns: ${parsed.spawns.map((x) => x.subagentType).join(',') || 'none'})` };
    if (sp.order < helper.order) return { pass: false, reason: 'the spawn came before the helper call' };
    if (sp.model !== c.alias) return { pass: false, reason: `spawn model is ${sp.model}, expected ${c.alias}` };
    return { pass: true, reason: `helper ${s.key}, spawn ${sp.subagentType} model ${sp.model}` };
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
    let killed = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      buf += d;
      if (!killed && parseStream(buf).spawns.length > 0) { killed = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', (d) => { buf += `\n${JSON.stringify({ type: 'error', error: String(d) })}\n`; });
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
    child.on('error', (e) => { clearTimeout(timer); resolve(`${JSON.stringify({ type: 'error', error: e.message })}\n`); });
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
        const parsed = parseStream(await runClaude(step, dir));
        const r = evaluate(step, config, parsed);
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  config ${config}  ${step}: ${r.reason}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { STEPS, CONFIGS, MODEL_KEYS, projectConfig, buildPrompt, parseStream, evaluate };

if (require.main === module) main();
