#!/usr/bin/env node
// Docs test per #325: ogni step del motore decide inline vs dispatch con
// model-route.js, non con la regola in prosa. Il testo canonico vive una volta
// in techniques.md; ogni punto di dispatch ha un gate imperativo che lo richiama.
// Run: node engine-route-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const SECTION = '**Route every step through model-route.js.**';
const SECTION_NAME = 'Route every step through model-route.js';

// --- Parte A: la sezione canonica in techniques.md -----------------------------------
{
  const techniques = read('_shared/techniques.md');
  const at = techniques.indexOf(SECTION);
  ok('A: techniques.md has the canonical routing paragraph', at !== -1);
  const sec = at === -1 ? '' : techniques.slice(at, techniques.indexOf('\n\n', at));
  const has = (...needles) => needles.every((n) => sec.includes(n));
  ok('A: the command with every flag',
    has('model-route.js <key> --session <your full model id>', '--session-effort', '--host codex', '--no-subagents', '<project root>'));
  ok('A: the two-path <hooks> lookup', has('../../hooks/lib/', '../trailhead/hooks/lib/', 'model-defaults-review.js'));
  ok('A: where the model id comes from', has('The exact model ID is', 'pass `unknown` only if it is truly absent'));
  ok('A: the key per step', has(
    'Plan -> `plan`', 'Execute -> `execute`', 'Fix -> `execute`', 'Code review -> `review`',
    'Goal-backward verification -> `verify`', 'Research -> `research`', 'Debug -> `debug`',
    'Codebase map -> `codebase-map`', 'Grilling -> `grill`'));
  ok('A: Fix spawns trailhead-fix in place of the returned agent', has('spawn `trailhead-fix` in place of the returned `agent`'));
  ok('A: Grilling keeps its own section', has('**Who runs a round**'));
  ok('A: route inline, suggest and warning', has('`route: inline`', '`suggest`', '`warning`'));
  ok('A: route dispatch uses agent and alias verbatim', has('`route: dispatch`', 'use its `agent` and `alias` verbatim'));
  ok('A: no hand decision', has('Never decide inline versus dispatch by hand', 'never read the config yourself'));
  ok('A: an unregistered agent runs inline', has('not registered', 'inline'));
  ok('A: the lean exception', has('accepted `lean` skip'));
  ok('A: the autonomous-run exception dispatches with no model override on an inline route',
    has('more than one slot', 'no model override'));
  ok('A: Codex spawns by agent_type, with a null alias', has('`agent_type=<agent>` on Codex', '`alias` is null'));
  ok('A: Claude Code passes alias as the Agent model override', has('`alias` as the `Agent` model override on Claude Code'));
  const rule = sec.indexOf('Never decide inline versus dispatch by hand');
  const lean = sec.indexOf('accepted `lean` skip');
  const auto = sec.indexOf('more than one slot');
  ok('A: both exclusions are stated after the rule, inside the paragraph',
    rule !== -1 && lean > rule && auto > rule && sec.indexOf('Two cases sit outside the route') > rule);
  ok('A: the helper still runs in the autonomous case', sec.slice(auto).includes('the helper is still run'));
  const dispatch = techniques.split('\n')[4] || '';
  ok('A: the dispatch paragraph points at the routing paragraph', dispatch.includes(SECTION_NAME));
  ok('A: the dispatch paragraph no longer restates the hand rule',
    !dispatch.includes('running inline instead only when') && !dispatch.includes('Keep the inline-vs-subagent decision on the full id'));
}

// --- Parte B: il gate a ogni punto di dispatch ---------------------------------------
const gateOk = (text, key) =>
  text.includes(`model-route.js ${key} --session <your full model id> <project root>`) &&
  text.includes('obey its `route`') &&
  text.includes('never decide inline versus dispatch by hand') &&
  text.includes(SECTION_NAME);

{
  const engines = read('trailhead-work/references/ticket-engines.md');
  const lines = engines.split('\n');
  const line = (prefix) => lines.find((l) => l.startsWith(prefix)) || '';
  ok('B: build Plan gates on plan', gateOk(line('2. **Plan**:'), 'plan'));
  ok('B: build Execute Dispatch gates on execute', gateOk(line('   - **Dispatch.** Spawn the **`trailhead-executor`**'), 'execute'));
  ok('B: bug Diagnose gates on debug', gateOk(line('2. **Diagnose**:'), 'debug'));
  const fix = line('   - **Dispatch.** Spawn the **`trailhead-fix`**');
  ok('B: bug Fix Dispatch gates on execute and spawns trailhead-fix', gateOk(fix, 'execute') && fix.includes('`trailhead-fix`'));
  ok('B: ticket-engines.md no longer restates the hand rule', !engines.includes('Inline only when the resolved model'));
  const GATE = '**First, route it.**';
  for (const [name, l] of [['Plan', line('2. **Plan**:')], ['Execute', line('   - **Dispatch.** Spawn the **`trailhead-executor`**')],
    ['Diagnose', line('2. **Diagnose**:')], ['Fix', fix]]) {
    ok(`B: ${name} spawns by agent_type on Codex`, l.includes('agent_type='));
    const g = l.indexOf(GATE);
    ok(`B: ${name} gate comes before any lean-skip or exception wording`, g !== -1 && (l.indexOf('`lean`') === -1 || g < l.indexOf('`lean`')));
  }
}

for (const [file, key, agent] of [
  ['code-review.md', 'review', 'trailhead-code-review'],
  ['verify.md', 'verify', 'trailhead-verify'],
  ['research.md', 'research', 'trailhead-research'],
  ['debug.md', 'debug', 'trailhead-debug'],
  ['codebase-map.md', 'codebase-map', 'trailhead-codebase-map'],
]) {
  const text = read(`_shared/techniques/${file}`);
  const gateAt = text.indexOf('**First, route it.**');
  const dispatchAt = text.indexOf(`**\`${agent}\`** agent`);
  const gate = gateAt === -1 ? '' : text.slice(gateAt, text.indexOf('\n', gateAt));
  ok(`B: ${file} has a routing gate before its dispatch sentence`, gateAt !== -1 && dispatchAt !== -1 && gateAt < dispatchAt);
  ok(`B: ${file} gate runs model-route.js ${key}`, gateOk(gate, key));
  ok(`B: ${file} gate exempts the dispatched ${agent}`, gate.includes(`If you are the \`${agent}\` agent, skip this gate`));
  ok(`B: ${file} no longer restates the hand rule`, !text.includes('inline only when the resolved model'));
  ok(`B: ${file} gate spawns by agent_type on Codex`, gate.includes('agent_type=<agent>'));
  ok(`B: ${file} gate points at the canonical paragraph`, gate.includes('Route every step through model-route.js'));
  ok(`B: ${file} gate comes before any lean-skip wording`, text.indexOf('`lean`') === -1 || gateAt < text.indexOf('`lean`'));
}

// --- Parte B2: auto.md ---------------------------------------------------------------
{
  const auto = read('trailhead-work/references/auto.md');
  const line = auto.split('\n').find((l) => l.startsWith('- **Background dispatch, never inline.**')) || '';
  ok('B: auto.md still dispatches every step in the background', line.includes('background subagent'));
  ok('B: auto.md runs the helper per step', line.includes('model-route.js <key> --session <your full model id> <project root>') && line.includes('Route every step through model-route.js'));
  ok('B: auto.md spawns with no model override on an inline route', line.includes('`route: inline`') && line.includes('no model override'));
}

// --- Parte B3: rifiniture della review di #325 --------------------------------------
{
  const cr = read('_shared/techniques/code-review.md');
  ok('B: code-review.md no longer says a lean skip is the only inline review', !cr.includes('only inline review'));
  ok('B: code-review.md says the review runs inline on route: inline', cr.includes('in the session on `route: inline`'));
  const audit = read('trailhead-manage/references/auditing.md');
  ok('B: auditing.md routes verify once per run through model-route.js',
    audit.includes('routes `verify` once per run through `model-route.js`') && audit.includes('Route every step through model-route.js'));
  const agent = fs.readFileSync(path.join(root, 'plugins', 'trailhead', 'agents', 'trailhead-codebase-map.md'), 'utf8');
  ok('B: the codebase-map agent no longer claims it has no model key', !agent.includes('no dedicated model key') && agent.includes('config.models.codebase-map'));
  const cfg = read('_shared/configuration.md');
  const ref = read('_shared/configuration-reference.md');
  ok('B: configuration docs say every key routes through model-route.js',
    !cfg.includes('every model key runs as a subagent') && !ref.includes('Every model key runs as a subagent') &&
    cfg.includes('every model key routes through `model-route.js`') && ref.includes('Every model key routes through `model-route.js`'));
}

// --- Parte C: la config descrive l'helper, non una decisione a mano -------------------
{
  const cfg = read('_shared/configuration.md');
  const ref = read('_shared/configuration-reference.md');
  ok('C: configuration.md lets the helper decide', cfg.includes('model-route.js') && !cfg.includes('Run Execute inline only when'));
  const bullet = (k) => ref.split('\n').find((l) => l.startsWith(`- \`${k}\` →`)) || '';
  ok('C: configuration-reference.md plan bullet points at the helper', bullet('plan').includes('model-route.js') && !bullet('plan').includes('inline only when'));
  ok('C: configuration-reference.md execute bullet points at the helper', bullet('execute').includes('model-route.js') && !bullet('execute').includes('inline in the session instead when'));
}

// --- Parte D: l'helper copre ogni chiave nominata ------------------------------------
{
  const { AGENT_OF } = require(path.join(root, 'plugins', 'trailhead', 'hooks', 'lib', 'model-route.js'));
  for (const key of ['plan', 'execute', 'review', 'verify', 'research', 'debug', 'codebase-map', 'grill']) {
    ok(`D: model-route.js knows ${key} on both hosts`, !!AGENT_OF.claude[key] && !!AGENT_OF.codex[key]);
  }
}

console.log(`engine-route-docs.test.js: ${passed} checks passed`);
