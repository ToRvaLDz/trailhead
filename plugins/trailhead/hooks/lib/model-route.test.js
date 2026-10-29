#!/usr/bin/env node
// Test per model-route.js (#323). Run: node model-route.test.js
// Niente framework: assert semplici, stesso stile degli altri test di hooks/lib.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, 'model-route.js');
const root = path.resolve(__dirname, '..', '..', '..', '..');
const { route, AGENT_OF, BALANCED, familyAlias, loadTierIds } = require(LIB);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const throws = (fn) => { try { fn(); } catch (e) { return true; } return false; };
const TIERS = loadTierIds('claude');
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

const claude = (extra) => route({ key: 'grill', host: 'claude', models: {}, sessionModel: SONNET, subagents: true, tierIds: TIERS, ...extra });
const codex = (extra) => route({ key: 'grill', host: 'codex', models: {}, sessionModel: 'gpt-5.6-terra', subagents: true, tierIds: TIERS, ...extra });

// --- Claude --------------------------------------------------------------------
{
  const r = claude({});
  ok('claude: sonnet session, key unset -> dispatch trailhead-grill on opus',
    r.route === 'dispatch' && r.agent === 'trailhead-grill' && r.model === OPUS && r.alias === 'opus');
  ok('claude: strong comes from the current model-defaults entry', TIERS.strong === OPUS);
  ok('claude: opus session, key unset -> inline', claude({ sessionModel: OPUS }).route === 'inline');
  ok('claude: sonnet pin in a sonnet session -> inline', claude({ models: { grill: SONNET } }).route === 'inline');
  ok('claude: inherit session -> inline', claude({ models: { grill: 'inherit session' } }).route === 'inline');
  for (const unset of [null, '', undefined]) {
    ok(`claude: ${JSON.stringify(unset)} resolves like an unset key`, claude({ models: { grill: unset } }).route === 'dispatch');
  }
  const pinned = claude({ sessionModel: OPUS, models: { grill: 'claude-opus-5' } });
  ok('claude: a different opus version dispatches with the opus alias', pinned.route === 'dispatch' && pinned.alias === 'opus' && pinned.model === 'claude-opus-5');
  ok('claude: a suffixed opus session + unset key -> inline', claude({ sessionModel: 'claude-opus-5-5[1m]' }).route === 'inline');
  const sfx = claude({ sessionModel: 'claude-sonnet-5-5[1m]' });
  ok('claude: a suffixed sonnet session + unset key -> dispatch opus', sfx.route === 'dispatch' && sfx.model === OPUS && sfx.alias === 'opus');
  ok('claude: a suffixed configured id equals the plain session id', claude({ sessionModel: SONNET, models: { grill: `${SONNET}[1m]` } }).route === 'inline');
  ok('claude: no subagents, suffixed session already on the model -> no suggestion', !claude({ subagents: false, sessionModel: 'claude-opus-5-5[1m]' }).suggest);
  const unk = claude({ models: { grill: 'my-custom-model' } });
  ok('claude: an unknown id that differs from the session -> inline with warning', unk.route === 'inline' && unk.warning === 'unknown-id');
  const unkEq = claude({ sessionModel: 'my-custom-model', models: { grill: 'my-custom-model' } });
  ok('claude: an unknown id equal to the session -> inline, no warning', unkEq.route === 'inline' && !unkEq.warning);
  const unknownSession = claude({ sessionModel: 'unknown' });
  ok('claude: session unknown, key unset -> dispatch', unknownSession.route === 'dispatch');
  ok('claude: a pin literally named unknown never equals the reserved value',
    claude({ sessionModel: 'unknown', models: { grill: 'unknown' } }).route === 'inline' && claude({ sessionModel: 'unknown', models: { grill: 'unknown' } }).warning === 'unknown-id');
  const ns = claude({ subagents: false });
  ok('claude: no subagents -> inline with a suggestion of the resolved id', ns.route === 'inline' && ns.suggest === OPUS);
  ok('claude: no subagents and already on that model -> no suggestion', !claude({ subagents: false, sessionModel: OPUS }).suggest);
  ok('claude: no subagents and unknown session -> suggestion', claude({ subagents: false, sessionModel: 'unknown' }).suggest === OPUS);
  ok('claude: alias families', familyAlias('claude-opus-5-5') === 'opus' && familyAlias('claude-sonnet-5') === 'sonnet' &&
    familyAlias('claude-haiku-4-5-20251001') === 'haiku' && familyAlias('claude-fable-5') === 'fable' && familyAlias('gpt-5.6-sol') === null);
  ok('claude: the config key for another activity uses its own Balanced tier',
    route({ key: 'codebase-map', host: 'claude', models: {}, sessionModel: OPUS, subagents: true, tierIds: TIERS }).model === TIERS.fast);
  ok('claude: models.codex.grill is ignored on the claude host',
    claude({ models: { codex: { grill: 'gpt-5.6-sol' } } }).model === OPUS);
}

// --- #323: grill non impostato segue plan ---
{
  const g = claude({ sessionModel: OPUS, models: { plan: SONNET } });
  ok('grill unset follows plan: plan sonnet in an opus session -> dispatch sonnet',
    g.route === 'dispatch' && g.agent === 'trailhead-grill' && g.model === SONNET && g.alias === 'sonnet');
  const bal = claude({ sessionModel: SONNET, models: {} });
  ok('grill unset + plan unset in a sonnet session -> dispatch opus (plan Balanced default)', bal.route === 'dispatch' && bal.model === OPUS && bal.alias === 'opus');
  ok('grill unset + plan equal to the session -> inline', claude({ sessionModel: SONNET, models: { plan: SONNET } }).route === 'inline');
  const own = claude({ sessionModel: OPUS, models: { plan: SONNET, grill: 'claude-haiku-5-5' } });
  ok('grill set overrides plan', own.route === 'dispatch' && own.model === 'claude-haiku-5-5');
  ok('plan inherit session + grill unset -> inline', claude({ models: { plan: 'inherit session' } }).route === 'inline');
  ok('grill inherit session wins over plan', claude({ models: { plan: OPUS, grill: 'inherit session' } }).route === 'inline');
  for (const unset of [null, '']) {
    ok(`grill ${JSON.stringify(unset)} follows plan`, claude({ sessionModel: OPUS, models: { plan: SONNET, grill: unset } }).model === SONNET);
  }
  const old = { plan: SONNET, execute: SONNET, research: SONNET, review: SONNET, debug: SONNET, verify: SONNET, 'codebase-map': 'claude-haiku-5-5' };
  const legacy = claude({ sessionModel: OPUS, models: old });
  ok('a config with the seven old keys and no grill grills on the plan id', legacy.route === 'dispatch' && legacy.model === SONNET);
  ok('other keys do not follow plan', route({ key: 'research', host: 'claude', models: { plan: SONNET }, sessionModel: SONNET, subagents: true, tierIds: TIERS }).route === 'inline');
  const noSub = claude({ sessionModel: OPUS, subagents: false, models: { plan: SONNET } });
  ok('no subagents: suggests the plan id', noSub.route === 'inline' && noSub.suggest === SONNET);
}

// --- Codex ---------------------------------------------------------------------
{
  ok('codex: key unset -> inline', codex({}).route === 'inline');
  ok('codex: inherit session -> inline', codex({ models: { codex: { grill: 'inherit session' } } }).route === 'inline');
  ok('codex: models.grill (claude ids) is ignored', codex({ models: { grill: OPUS } }).route === 'inline');
  const d = codex({ models: { codex: { grill: 'gpt-5.6-sol' } } });
  ok('codex: a pin different from the session -> dispatch trailhead-grill', d.route === 'dispatch' && d.agent === 'trailhead-grill' && d.alias === null && d.model === 'gpt-5.6-sol');
  ok('codex: a bare pin equal to the session -> inline', codex({ sessionModel: 'gpt-5.6-sol', models: { codex: { grill: 'gpt-5.6-sol' } } }).route === 'inline');
  const pin = { model: 'gpt-5.6-sol', effort: 'high' };
  const eq = { sessionModel: 'gpt-5.6-sol', models: { codex: { grill: pin } } };
  ok('codex: equal model and equal effort -> inline', codex({ ...eq, sessionEffort: 'high' }).route === 'inline');
  ok('codex: equal model, different effort -> dispatch', codex({ ...eq, sessionEffort: 'medium' }).route === 'dispatch');
  ok('codex: equal model, effort pinned, session effort unknown -> dispatch', codex(eq).route === 'dispatch');
  ok('codex: equal model, no pinned effort, any session effort -> inline',
    codex({ sessionModel: 'gpt-5.6-sol', sessionEffort: 'low', models: { codex: { grill: { model: 'gpt-5.6-sol' } } } }).route === 'inline');
  ok('codex: session unknown -> dispatch', codex({ sessionModel: 'unknown', models: { codex: { grill: 'gpt-5.6-sol' } } }).route === 'dispatch');
  ok('codex: an object pin without a model stays inline', codex({ models: { codex: { grill: { effort: 'high' } } } }).route === 'inline');
  ok('codex: execute dispatches the projected trailhead-execute',
    route({ key: 'execute', host: 'codex', models: { codex: { execute: 'gpt-5.6-sol' } }, sessionModel: 'gpt-5.6-terra', subagents: true, tierIds: TIERS }).agent === 'trailhead-execute');
}

{
  const cx = (extra) => codex({ ...extra });
  const planPin = { codex: { plan: 'gpt-5.6-sol' } };
  const d = cx({ models: planPin });
  ok('codex: grill unset + codex.plan pinned -> dispatch trailhead-grill on the plan pin', d.route === 'dispatch' && d.agent === 'trailhead-grill' && d.model === 'gpt-5.6-sol');
  ok('codex: grill unset + codex.plan equal to the session -> inline', cx({ sessionModel: 'gpt-5.6-sol', models: planPin }).route === 'inline');
  ok('codex: plan pin with effort follows the same effort rules',
    cx({ sessionModel: 'gpt-5.6-sol', models: { codex: { plan: { model: 'gpt-5.6-sol', effort: 'high' } } } }).route === 'dispatch' &&
    cx({ sessionModel: 'gpt-5.6-sol', sessionEffort: 'high', models: { codex: { plan: { model: 'gpt-5.6-sol', effort: 'high' } } } }).route === 'inline');
  ok('codex: grill set overrides plan', cx({ sessionModel: 'gpt-5.6-sol', models: { codex: { plan: 'gpt-5.6-terra', grill: 'gpt-5.6-sol' } } }).route === 'inline');
  ok('codex: grill inherit session wins over plan', cx({ models: { codex: { plan: 'gpt-5.6-sol', grill: 'inherit session' } } }).route === 'inline');
  ok('codex: grill unset + plan unset -> inline', cx({ models: { codex: {} } }).route === 'inline');
}

// --- agent mapping -------------------------------------------------------------
{
  const { MODEL_KEYS, codexAgentTomlPlan } = require(path.join(root, 'bin', 'lib', 'codex-projection.js'));
  const keys = [...MODEL_KEYS].sort();
  ok('agents: both tables cover exactly the MODEL_KEYS',
    JSON.stringify(Object.keys(AGENT_OF.claude).sort()) === JSON.stringify(keys) &&
    JSON.stringify(Object.keys(AGENT_OF.codex).sort()) === JSON.stringify(keys));
  for (const [key, name] of Object.entries(AGENT_OF.claude)) {
    ok(`agents: claude ${key} -> ${name} exists under agents/`, fs.existsSync(path.join(root, 'plugins', 'trailhead', 'agents', `${name}.md`)));
  }
  const defs = fs.readdirSync(path.join(root, 'plugins', 'trailhead', 'agents'))
    .filter((f) => /^trailhead-.*\.md$/.test(f)).sort()
    .map((f) => ({ name: f.slice(0, -3), description: 'd', tools: 'Read', body: 'b' }));
  const models = Object.fromEntries(keys.map((k) => [k, `pin-${k}`]));
  const writes = codexAgentTomlPlan('/c', models, defs).writes;
  for (const [key, name] of Object.entries(AGENT_OF.codex)) {
    const w = writes.find((x) => x.content.includes(`model = "pin-${key}"`));
    ok(`agents: codex ${key} -> ${name} is the name the projection emits`, !!w && w.name === name);
  }
  ok('agents: execute and review map to the distinct per-host names',
    AGENT_OF.claude.execute === 'trailhead-executor' && AGENT_OF.codex.execute === 'trailhead-execute' &&
    AGENT_OF.claude.review === 'trailhead-code-review' && AGENT_OF.codex.review === 'trailhead-review');
  ok('agents: an unknown key throws', throws(() => route({ key: 'nope', host: 'claude', models: {}, sessionModel: 'unknown', subagents: true, tierIds: TIERS })));
  ok('agents: an unknown host throws', throws(() => route({ key: 'grill', host: 'mars', models: {}, sessionModel: 'unknown', subagents: true, tierIds: TIERS })));
}

// --- BALANCED pinned to the profile table -----------------------------------------
{
  const ref = fs.readFileSync(path.join(root, 'plugins', 'trailhead', 'skills', '_shared', 'configuration-reference.md'), 'utf8').split('\n');
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
  const header = cells(ref.find((l) => l.startsWith('| profile |')));
  const row = cells(ref.find((l) => l.startsWith('| **Balanced** |')));
  const parsed = Object.fromEntries(header.slice(1).map((k, i) => [k, row[i + 1]]));
  const { grill: tableGrill, ...tableRest } = parsed;
  ok('BALANCED equals the Balanced row of the profile table, minus grill', JSON.stringify(BALANCED) === JSON.stringify(tableRest) && !('grill' in BALANCED));
  ok('the grill column mirrors the plan column in every profile', ['High', 'Balanced', 'Low'].every((name) => {
    const r = cells(ref.find((l) => l.startsWith(`| **${name}** |`)));
    return r[header.indexOf('grill')] === r[header.indexOf('plan')];
  }) && tableGrill === parsed.plan);
}

// --- CLI -----------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-model-route-'));
  const globalDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(globalDir, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { grill: 'claude-sonnet-5', plan: 'claude-haiku-5-5' } }));
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(proj, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.trailhead', 'config.json'), JSON.stringify({ models: { grill: 'claude-opus-5' } }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: globalDir, CODEX_HOME: path.join(tmp, 'codex') };
  const run = (args) => spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', env });
  const r = run(['grill', '--session', SONNET, proj]);
  const j = JSON.parse(r.stdout);
  ok('cli: exit 0 and one JSON line with the six keys',
    r.status === 0 && r.stdout.trim().split('\n').length === 1 &&
    JSON.stringify(Object.keys(j)) === JSON.stringify(['route', 'agent', 'model', 'alias', 'suggest', 'warning']));
  ok('cli: the project config wins over the global one key by key', j.route === 'dispatch' && j.model === 'claude-opus-5' && j.alias === 'opus' && j.agent === 'trailhead-grill');
  const g = JSON.parse(run(['grill', '--session', SONNET, tmp]).stdout);
  ok('cli: with no project above, the global config applies', g.route === 'dispatch' && g.model === 'claude-sonnet-5' && g.alias === 'sonnet');
  const ns = JSON.parse(run(['grill', '--session', 'unknown', '--no-subagents', proj]).stdout);
  ok('cli: --no-subagents inline with a suggestion', ns.route === 'inline' && ns.suggest === 'claude-opus-5');
  const cx = JSON.parse(run(['grill', '--session', 'gpt-5.6-terra', '--host', 'codex', proj]).stdout);
  ok('cli: --host codex ignores models.grill', cx.route === 'inline');
  fs.writeFileSync(path.join(proj, '.trailhead', 'config.json'), JSON.stringify({ models: { codex: { grill: { model: 'gpt-5.6-sol', effort: 'high' } } } }));
  const ce = JSON.parse(run(['grill', '--session', 'gpt-5.6-sol', '--session-effort', 'high', '--host', 'codex', proj]).stdout);
  ok('cli: --session-effort equal to the pinned effort -> inline', ce.route === 'inline');
  const cd = JSON.parse(run(['grill', '--session', 'gpt-5.6-sol', '--session-effort', 'medium', '--host', 'codex', proj]).stdout);
  ok('cli: a different --session-effort -> dispatch', cd.route === 'dispatch' && cd.agent === 'trailhead-grill');
  for (const [name, args] of [
    ['a missing --session', ['grill', proj]],
    ['an empty --session', ['grill', '--session', '', proj]],
    ['an unknown flag', ['grill', '--session', SONNET, '--bogus', proj]],
    ['an unknown key', ['nope', '--session', SONNET, proj]],
    ['no key', ['--session', SONNET]],
    ['an unknown host', ['grill', '--session', SONNET, '--host', 'mars', proj]],
  ]) {
    const x = run(args);
    ok(`cli: ${name} exits 2 with nothing on stdout`, x.status === 2 && x.stdout === '' && x.stderr.length > 0);
  }
  // implicit grill per layer (project plan beats a global grill)
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { grill: 'claude-haiku-5-5' } }));
  fs.writeFileSync(path.join(proj, '.trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-sonnet-5' } }));
  const lp = JSON.parse(run(['grill', '--session', OPUS, proj]).stdout);
  ok('cli: project plan + no project grill beats a global grill', lp.route === 'dispatch' && lp.model === 'claude-sonnet-5');
  fs.writeFileSync(path.join(proj, '.trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-sonnet-5', grill: 'claude-opus-5' } }));
  ok('cli: a project grill always wins', JSON.parse(run(['grill', '--session', SONNET, proj]).stdout).model === 'claude-opus-5');
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-sonnet-5' } }));
  fs.writeFileSync(path.join(proj, '.trailhead', 'config.json'), JSON.stringify({ models: {} }));
  ok('cli: global plan + no grill anywhere -> global plan', JSON.parse(run(['grill', '--session', OPUS, proj]).stdout).model === 'claude-sonnet-5');
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { grill: 'claude-haiku-5-5', plan: 'claude-opus-5' } }));
  fs.writeFileSync(path.join(proj, '.trailhead', 'config.json'), JSON.stringify({ models: { plan: 'inherit session' } }));
  ok('cli: project plan inherit session + global grill -> inline', JSON.parse(run(['grill', '--session', SONNET, proj]).stdout).route === 'inline');
  // codex
  const codexHome = path.join(tmp, 'codex');
  fs.mkdirSync(path.join(codexHome, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'trailhead', 'config.json'), JSON.stringify({ models: { codex: { grill: 'gpt-5.6-luna' } } }));
  fs.writeFileSync(path.join(proj, '.trailhead', 'config.json'), JSON.stringify({ models: { codex: { plan: 'gpt-5.6-sol' } } }));
  const cxl = JSON.parse(run(['grill', '--session', 'gpt-5.6-terra', '--host', 'codex', proj]).stdout);
  ok('cli codex: project codex.plan + no project grill beats a global codex.grill', cxl.route === 'dispatch' && cxl.model === 'gpt-5.6-sol');
  fs.writeFileSync(path.join(proj, '.trailhead', 'config.json'), JSON.stringify({ models: {} }));
  ok('cli codex: only a global grill pin -> that pin', JSON.parse(run(['grill', '--session', 'gpt-5.6-terra', '--host', 'codex', proj]).stdout).model === 'gpt-5.6-luna');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`model-route.test.js: ${passed} assertions passed`);
