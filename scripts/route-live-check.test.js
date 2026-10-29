#!/usr/bin/env node
// Test offline di scripts/route-live-check.js (#325): il parser dello stream
// stream-json e la valutazione, su fixture. Non lancia mai `claude`.
// Run: node route-live-check.test.js
const assert = require('assert');
const path = require('path');
const { parseStream, evaluate, STEPS, CONFIGS, projectConfig, buildPrompt } = require(path.join(__dirname, 'route-live-check.js'));

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

let seq = 0;
const line = (o) => JSON.stringify(o);
const assistant = (...content) => line({ type: 'assistant', message: { role: 'assistant', content } });
const text = (t) => ({ type: 'text', text: t });
const spawnUse = (name, input) => ({ type: 'tool_use', id: `s${++seq}`, name, input });
// Risultato di un tool: content stringa oppure array di blocchi text, come nello stream reale.
const result = (id, body, asArray) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: asArray ? [{ type: 'text', text: body }] : body }] } });
const helperJson = (route, agent, alias) => JSON.stringify({ route, agent, model: 'claude-x', alias, suggest: null, warning: null });
// Chiamata all'helper e suo risultato: due righe dello stream.
const helper = (key, out, o = {}) => {
  const id = `h${++seq}`;
  const cmd = o.cmd || `node /x/plugins/trailhead/hooks/lib/model-route.js ${key} --session claude-sonnet-5-5 /tmp/p`;
  return [assistant({ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }), result(id, out, o.asArray)].join('\n');
};
const dispatchOf = (step, o = {}) => [
  helper(STEPS[step].key, helperJson('dispatch', o.helperAgent || STEPS[step].helperAgent || STEPS[step].agent, o.alias || 'opus'), o),
  assistant(spawnUse('Agent', { subagent_type: `trailhead:${o.spawnAgent || STEPS[step].agent}`, model: o.model || 'opus', prompt: 'OK' })),
].join('\n');
const inlineOf = (step, o = {}) => [
  helper(STEPS[step].key, helperJson(o.route || 'inline', STEPS[step].agent, null), o),
  assistant(text(`route: inline\nINLINE ${step}`)),
].join('\n');

// --- Dispatch ---------------------------------------------------------------------
{
  const s = [line({ type: 'system', subtype: 'init' }), assistant(text('Routing first.')), dispatchOf('plan'),
    line({ type: 'result', subtype: 'success', is_error: false, result: 'done' })].join('\n');
  const p = parseStream(s);
  ok('parse: one helper call with its key, session and parsed JSON', p.helperCalls.length === 1 && p.helperCalls[0].key === 'plan' &&
    p.helperCalls[0].session === 'claude-sonnet-5-5' && p.helperCalls[0].json && p.helperCalls[0].json.route === 'dispatch');
  ok('parse: one spawn with subagent_type and model', p.spawns.length === 1 && p.spawns[0].subagentType === 'trailhead:trailhead-plan' && p.spawns[0].model === 'opus');
  ok('parse: the helper call precedes the spawn', p.helperCalls[0].order < p.spawns[0].order);
  ok('parse: no inline marker, no auth error', p.inlineMarkers.length === 0 && !p.authError);
  ok('evaluate D plan: pass', evaluate('plan', 'D', p).pass);
  ok('evaluate I plan: fail on a spawn', !evaluate('plan', 'I', p).pass);
  ok('evaluate D plan: fail when the spawn model is wrong', !evaluate('plan', 'D', parseStream(dispatchOf('plan', { model: 'sonnet' }))).pass);
  ok('evaluate D plan: fail when the spawn agent is wrong', !evaluate('plan', 'D', parseStream(dispatchOf('plan', { spawnAgent: 'trailhead-debug' }))).pass);
  ok('evaluate D plan: fail when the helper named another agent', !evaluate('plan', 'D', parseStream(dispatchOf('plan', { helperAgent: 'trailhead-debug' }))).pass);
  ok('evaluate D plan: fail when the helper alias differs from the spawn model', !evaluate('plan', 'D', parseStream(dispatchOf('plan', { alias: 'sonnet' }))).pass);
  ok('evaluate D plan: the tool_result as an array of text blocks passes', evaluate('plan', 'D', parseStream(dispatchOf('plan', { asArray: true }))).pass);
}

// --- Fix: l'helper nomina l'executor, lo spawn e' trailhead-fix -------------------------
{
  ok('STEPS: fix expects the executor from the helper', STEPS.fix.helperAgent === 'trailhead-executor');
  ok('evaluate D fix: helper executor + spawn trailhead-fix passes', evaluate('fix', 'D', parseStream(dispatchOf('fix'))).pass);
  ok('evaluate D fix: a spawn of the executor fails', !evaluate('fix', 'D', parseStream(dispatchOf('fix', { spawnAgent: 'trailhead-executor' }))).pass);
  ok('evaluate D execute: a spawn of trailhead-fix fails', !evaluate('execute', 'D', parseStream(dispatchOf('execute', { spawnAgent: 'trailhead-fix' }))).pass);
  ok('evaluate D execute: passes', evaluate('execute', 'D', parseStream(dispatchOf('execute'))).pass);
  const taskTool = [helper('review', helperJson('dispatch', 'trailhead-code-review', 'opus')),
    assistant(spawnUse('Task', { subagent_type: 'trailhead-code-review', model: 'opus' }))].join('\n');
  ok('parse: Task counts as a spawn', parseStream(taskTool).spawns.length === 1 && evaluate('review', 'D', parseStream(taskTool)).pass);
}

// --- Inline -----------------------------------------------------------------------
{
  const p = parseStream(inlineOf('review'));
  ok('parse: INLINE marker captured', p.inlineMarkers.length === 1 && p.inlineMarkers[0] === 'review');
  ok('evaluate I review: pass', evaluate('review', 'I', p).pass);
  ok('evaluate D review: fail without a spawn', !evaluate('review', 'D', p).pass);
  ok('evaluate I verify: fail on a marker for another step', !evaluate('verify', 'I', parseStream(inlineOf('review').replace(/model-route.js review/, 'model-route.js verify'))).pass);
  ok('evaluate I review: a route mismatch (helper says dispatch) fails', !evaluate('review', 'I', parseStream(inlineOf('review', { route: 'dispatch' }))).pass);
  ok('evaluate D plan: a helper that says inline fails even with a spawn', !evaluate('plan',
    'D', parseStream([helper('plan', helperJson('inline', 'trailhead-plan', null)), assistant(spawnUse('Agent', { subagent_type: 'trailhead-plan', model: 'opus' }))].join('\n'))).pass);
}

// --- Helper fallito, senza --session, mancante o con chiave sbagliata -------------------
{
  const failed = [helper('review', 'Error: unknown flag', {}), assistant(text('INLINE review'))].join('\n');
  const pf = parseStream(failed);
  ok('parse: a non-JSON helper result is kept as an error', pf.helperCalls[0].json === null && /unknown flag/.test(pf.helperCalls[0].error));
  ok('evaluate: a failed helper followed by INLINE fails', !evaluate('review', 'I', pf).pass);
  const empty = parseStream([helper('review', helperJson('inline', 'trailhead-code-review', null), { cmd: 'node /x/model-route.js review --session  /tmp/p' }), assistant(text('INLINE review'))].join('\n'));
  ok('evaluate: an empty --session value fails', !evaluate('review', 'I', empty).pass);
  const noSession = parseStream([helper('review', helperJson('inline', 'trailhead-code-review', null), { cmd: 'node /x/model-route.js review /tmp/p' }), assistant(text('INLINE review'))].join('\n'));
  ok('parse: missing --session leaves session null', noSession.helperCalls[0].session === null);
  ok('evaluate: a missing --session fails', !evaluate('review', 'I', noSession).pass);
  const flagAsValue = parseStream([helper('review', helperJson('inline', 'trailhead-code-review', null), { cmd: 'node /x/model-route.js review --session --host codex /tmp/p' }), assistant(text('INLINE review'))].join('\n'));
  ok('evaluate: --session followed by another flag fails', !evaluate('review', 'I', flagAsValue).pass);
  const noResult = parseStream(assistant({ type: 'tool_use', id: 'zz', name: 'Bash', input: { command: 'node m/model-route.js review --session s /p' } }));
  ok('evaluate: a helper call with no result fails', !evaluate('review', 'I', noResult).pass);

  const noHelper = parseStream(assistant(spawnUse('Agent', { subagent_type: 'trailhead-debug', model: 'opus' })));
  ok('evaluate: a spawn with no helper call fails', !evaluate('debug', 'D', noHelper).pass);
  const wrongKey = parseStream([helper('plan', helperJson('dispatch', 'trailhead-plan', 'opus')), assistant(spawnUse('Agent', { subagent_type: 'trailhead-debug', model: 'opus' }))].join('\n'));
  ok('evaluate: a helper call with the wrong key fails', !evaluate('debug', 'D', wrongKey).pass);
  ok('parse: a grep mentioning model-route.js is not a helper call', parseStream(assistant({ type: 'tool_use', id: 'g', name: 'Bash', input: { command: 'grep -n model-route.js /x' } })).helperCalls.length === 0);
  ok('parse: key with a hyphen (codebase-map)', parseStream(assistant({ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'node m/model-route.js codebase-map --session s /p' } })).helperCalls[0].key === 'codebase-map');
}

// --- Auth error e righe non JSON ----------------------------------------------------
{
  const auth = parseStream(line({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key - Please run /login' }));
  ok('parse: an auth error is flagged', auth.authError === true);
  ok('evaluate: an auth error is reported as such, not as a routing failure', /auth/i.test(evaluate('plan', 'D', auth).reason));
  ok('parse: a stream error event with an auth message is flagged', parseStream(line({ type: 'error', error: '401 Unauthorized' })).authError === true);
  ok('parse: plain text (e.g. stderr) is not parsed as an event', parseStream('Invalid API key\n' + inlineOf('review')).authError === false);
  ok('parse: skips non-JSON lines', parseStream('not json\n\n' + inlineOf('review')).inlineMarkers.length === 1);
}

// --- Matrice, config del progetto, prompt -------------------------------------------
{
  ok('STEPS: the 8 steps', JSON.stringify(Object.keys(STEPS)) === JSON.stringify(['plan', 'execute', 'fix', 'review', 'verify', 'research', 'debug', 'codebase-map']));
  ok('STEPS: fix routes on execute and spawns trailhead-fix', STEPS.fix.key === 'execute' && STEPS.fix.agent === 'trailhead-fix');
  ok('STEPS: agents', STEPS.execute.agent === 'trailhead-executor' && STEPS.review.agent === 'trailhead-code-review' && STEPS['codebase-map'].agent === 'trailhead-codebase-map');
  ok('CONFIGS: D is opus, I is sonnet', CONFIGS.D.model === 'claude-opus-5-5' && CONFIGS.D.alias === 'opus' && CONFIGS.I.model === 'claude-sonnet-5-5' && CONFIGS.I.alias == null);
  const cfg = projectConfig('claude-opus-5-5');
  ok('projectConfig: every key pinned', ['plan', 'execute', 'research', 'review', 'debug', 'verify', 'codebase-map', 'grill'].every((k) => cfg.models[k] === 'claude-opus-5-5'));
  const prompt = buildPrompt('fix', '/tmp/proj', '/repo/skills');
  ok('buildPrompt: names the step, the root, the stop rule and the marker', prompt.includes('/tmp/proj') && prompt.includes('INLINE fix') && /do not run gh/i.test(prompt));
}

console.log(`route-live-check.test.js: ${passed} checks passed`);
