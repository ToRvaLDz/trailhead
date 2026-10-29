#!/usr/bin/env node
// Test offline di scripts/route-live-check.js (#325): il parser dello stream
// stream-json e la valutazione, su fixture. Non lancia mai `claude`.
// Run: node route-live-check.test.js
const assert = require('assert');
const path = require('path');
const { parseStream, evaluate, STEPS, CONFIGS, projectConfig, buildPrompt } = require(path.join(__dirname, 'route-live-check.js'));

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const line = (o) => JSON.stringify(o);
const assistant = (...content) => line({ type: 'assistant', message: { role: 'assistant', content } });
const bash = (command) => ({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command } });
const spawnUse = (name, input) => ({ type: 'tool_use', id: 's1', name, input });
const text = (t) => ({ type: 'text', text: t });

// --- Spawn dopo la chiamata all'helper ------------------------------------------
const dispatchStream = [
  line({ type: 'system', subtype: 'init' }),
  assistant(text('Routing first.')),
  assistant(bash('node /x/plugins/trailhead/hooks/lib/model-route.js plan --session claude-sonnet-5-5 /tmp/p')),
  assistant(spawnUse('Agent', { subagent_type: 'trailhead:trailhead-plan', model: 'opus', prompt: 'OK' })),
  line({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
].join('\n');
{
  const p = parseStream(dispatchStream);
  ok('parse: one helper call with its key', p.helperCalls.length === 1 && p.helperCalls[0].key === 'plan');
  ok('parse: one spawn with subagent_type and model', p.spawns.length === 1 && p.spawns[0].subagentType === 'trailhead:trailhead-plan' && p.spawns[0].model === 'opus');
  ok('parse: the helper call precedes the spawn', p.helperCalls[0].order < p.spawns[0].order);
  ok('parse: no inline marker, no auth error', p.inlineMarkers.length === 0 && !p.authError);
  ok('evaluate D plan: pass', evaluate('plan', 'D', p).pass);
  ok('evaluate I plan: fail on a spawn', !evaluate('plan', 'I', p).pass);
  ok('evaluate D plan: fail when the model alias is wrong', !evaluate('plan', 'D', parseStream(dispatchStream.replace('"model":"opus"', '"model":"sonnet"'))).pass);
  ok('evaluate D plan: fail when the agent is wrong', !evaluate('plan', 'D', parseStream(dispatchStream.replace('trailhead-plan', 'trailhead-debug'))).pass);
}

// --- Task al posto di Agent ------------------------------------------------------
{
  const s = [
    assistant(bash('node m/model-route.js execute --session s /p')),
    assistant(spawnUse('Task', { subagent_type: 'trailhead-fix', model: 'opus' })),
  ].join('\n');
  const p = parseStream(s);
  ok('parse: Task counts as a spawn', p.spawns.length === 1);
  ok('evaluate D fix: helper key is execute, agent is trailhead-fix', evaluate('fix', 'D', p).pass);
  ok('evaluate D execute: fix agent is not the executor', !evaluate('execute', 'D', p).pass);
}

// --- Inline -----------------------------------------------------------------------
const inlineStream = [
  assistant(bash('node /x/model-route.js review --session claude-sonnet-5-5 /tmp/p')),
  assistant(text('route: inline\nINLINE review')),
].join('\n');
{
  const p = parseStream(inlineStream);
  ok('parse: INLINE marker captured', p.inlineMarkers.length === 1 && p.inlineMarkers[0] === 'review');
  ok('evaluate I review: pass', evaluate('review', 'I', p).pass);
  ok('evaluate D review: fail without a spawn', !evaluate('review', 'D', p).pass);
  ok('evaluate I verify: fail on a marker for another step', !evaluate('verify', 'I', p).pass);
}

// --- Chiamata all'helper mancante o con chiave sbagliata --------------------------
{
  const noHelper = parseStream([assistant(spawnUse('Agent', { subagent_type: 'trailhead-debug', model: 'opus' }))].join('\n'));
  ok('evaluate: a spawn with no helper call fails', !evaluate('debug', 'D', noHelper).pass);
  const wrongKey = parseStream([assistant(bash('node m/model-route.js plan --session s /p')), assistant(spawnUse('Agent', { subagent_type: 'trailhead-debug', model: 'opus' }))].join('\n'));
  ok('evaluate: a helper call with the wrong key fails', !evaluate('debug', 'D', wrongKey).pass);
  ok('parse: a grep mentioning model-route.js is not a helper call', parseStream(assistant(bash('grep -n model-route.js /x'))).helperCalls.length === 0);
  ok('parse: key with a hyphen (codebase-map)', parseStream(assistant(bash('node m/model-route.js codebase-map --session s /p'))).helperCalls[0].key === 'codebase-map');
}

// --- Auth error e righe non JSON ----------------------------------------------------
{
  const auth = parseStream([line({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key - Please run /login' })].join('\n'));
  ok('parse: an auth error is flagged', auth.authError === true);
  ok('evaluate: an auth error is reported as such, not as a routing failure', /auth/i.test(evaluate('plan', 'D', auth).reason));
  const noisy = parseStream('not json\n\n' + inlineStream);
  ok('parse: skips non-JSON lines', noisy.inlineMarkers.length === 1);
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
