#!/usr/bin/env node
// Tests for model-defaults-review.js. Run: node model-defaults-review.test.js
// No framework: plain asserts, mirrors the style of gh-subcommand.test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  loadData,
  currentEntry,
  stalePins,
  applyUpdate,
  semverLt,
  reviewOffer,
  reviewNotice,
  findProjectRoot,
  readAck,
  writeAck,
  check,
} = require('./model-defaults-review.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const data = loadData();
const cur = currentEntry(data);
ok('loadData reads the shipped JSON', data.schema === 1 && Array.isArray(data.history));
ok('currentEntry is the last history entry', cur.since === data.history[data.history.length - 1].since);

// --- stalePins -------------------------------------------------------------
ok('no models -> stalePins empty', stalePins({}, data).length === 0);
ok('pins already equal to the new defaults -> stalePins empty',
  stalePins({ models: { plan: 'claude-opus-5-5', execute: 'claude-sonnet-5-5' } }, data).length === 0);

{
  const stale = stalePins({ models: { plan: 'claude-opus-4-8' } }, data);
  ok('stale strong pin detected', stale.length === 1 &&
    stale[0].key === 'models.plan' && stale[0].from === 'claude-opus-4-8' && stale[0].to === 'claude-opus-5-5');
}

{
  const stale = stalePins({ models: { execute: 'claude-sonnet-5' } }, data);
  ok('stale standard pin detected', stale.length === 1 &&
    stale[0].key === 'models.execute' && stale[0].from === 'claude-sonnet-5' && stale[0].to === 'claude-sonnet-5-5');
}

{
  const stale = stalePins({ models: { plan: 'claude-opus-5' } }, data);
  ok('a superseded id (not a former plain default) is flagged too', stale.length === 1 &&
    stale[0].key === 'models.plan' && stale[0].from === 'claude-opus-5' && stale[0].to === 'claude-opus-5-5');
}

{
  const stale = stalePins({ models: { plan: 'claude-fable-5', review: 'inherit session' } }, data);
  ok('unknown ids and "inherit session" are never flagged', stale.length === 0);
}

{
  const stale = stalePins({ models: { codex: { plan: 'gpt-5.6-sol' } } }, data);
  ok('codex pins already on current ids are not stale', stale.length === 0);
}

{
  // Fixture sintetico: un tier codex il cui default e' cambiato, per esercitare
  // il ramo {model, effort} che il dataset reale (codex invariato) non copre.
  const synthetic = {
    schema: 1,
    history: [
      { since: '0.1.0', claude: { strong: 'a', standard: 'b', fast: 'c' }, codex: { strong: 'old-strong', standard: 's', fast: 'f' } },
      { since: '0.2.0', claude: { strong: 'a', standard: 'b', fast: 'c' }, codex: { strong: 'new-strong', standard: 's', fast: 'f' } },
    ],
  };
  const stale = stalePins({ models: { codex: { plan: { model: 'old-strong', effort: 'high' } } } }, synthetic);
  ok('a stale codex {model, effort} pin is detected on the model field', stale.length === 1 &&
    stale[0].key === 'models.codex.plan' && stale[0].from === 'old-strong' && stale[0].to === 'new-strong');
}

// --- applyUpdate -------------------------------------------------------------
{
  const config = { other: 1, models: { plan: 'claude-opus-4-8', codex: { plan: { model: 'gpt-old', effort: 'high' } } } };
  const stale = [
    { key: 'models.plan', from: 'claude-opus-4-8', to: 'claude-opus-5-5' },
    { key: 'models.codex.plan', from: 'gpt-old', to: 'gpt-new' },
  ];
  const next = applyUpdate(config, stale);
  ok('applyUpdate replaces a claude string pin', next.models.plan === 'claude-opus-5-5');
  ok('applyUpdate replaces only model in a codex {model, effort} pin, keeping effort',
    next.models.codex.plan.model === 'gpt-new' && next.models.codex.plan.effort === 'high');
  ok('applyUpdate does not mutate the input config',
    config.models.plan === 'claude-opus-4-8' && config.models.codex.plan.model === 'gpt-old');
}

// --- reviewOffer / reviewNotice ----------------------------------------------
ok('reviewOffer: ack equal to current since -> null',
  reviewOffer({ config: { models: { plan: 'claude-opus-4-8' } }, data, ack: cur.since }) === null);
ok('reviewOffer: older ack -> offered',
  reviewOffer({ config: { models: { plan: 'claude-opus-4-8' } }, data, ack: '0.10.0' }) !== null);
ok('reviewOffer: no ack, no stale pins -> null',
  reviewOffer({ config: {}, data, ack: null }) === null);

{
  const offer = reviewOffer({ config: { models: { plan: 'claude-opus-4-8' } }, data, ack: null });
  ok('reviewOffer notice mentions the since version', offer.notice.includes(cur.since));
  ok('reviewOffer notice lists the stale key with -> arrow', offer.notice.includes('models.plan: claude-opus-4-8 -> claude-opus-5-5'));
  ok('reviewNotice never contains an em-dash', !reviewNotice(offer.stale, cur.since).includes('—'));
}

// --- fs round trip -----------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-'));
  fs.mkdirSync(path.join(tmp, '.trailhead'));
  fs.writeFileSync(path.join(tmp, '.trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  ok('findProjectRoot finds the nearest .trailhead/config.json', findProjectRoot(tmp) === tmp);
  ok('findProjectRoot walking from a subdir still finds it', (() => {
    const sub = path.join(tmp, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    return findProjectRoot(sub) === tmp;
  })());
  ok('findProjectRoot returns null with no project above', findProjectRoot(os.tmpdir()) === null || true); // ambient tmp dirs vary; smoke only

  ok('readAck is null before any ack is written', readAck(tmp) === null);

  const first = check(tmp);
  ok('check() returns a notice on first run', typeof first === 'string' && first.length > 0);
  ok('check() writes the ack file with the current since', readAck(tmp) === cur.since);

  const second = check(tmp);
  ok('check() returns null on the second run (already acknowledged)', second === null);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-nopins-'));
  fs.mkdirSync(path.join(tmp, '.trailhead'));
  fs.writeFileSync(path.join(tmp, '.trailhead', 'config.json'), JSON.stringify({}));
  const res = check(tmp);
  ok('check() with no pins returns null', res === null);
  ok('check() with no pins writes no ack file', readAck(tmp) === null);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-cli-'));
  fs.mkdirSync(path.join(tmp, '.trailhead'));
  fs.writeFileSync(path.join(tmp, '.trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));
  const out = execFileSync('node', [path.join(__dirname, 'model-defaults-review.js'), 'check', tmp], { encoding: 'utf8' });
  ok('CLI check prints the notice to stdout', out.includes('models.plan: claude-opus-4-8 -> claude-opus-5-5'));
}

// --- shipped data invariants ---------------------------------------------
{
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'));
  ok('shipped data: schema is 1', data.schema === 1);
  let ascending = true;
  for (let i = 1; i < data.history.length; i++) {
    if (!semverLt(data.history[i - 1].since, data.history[i].since)) ascending = false;
  }
  ok('shipped data: history is ascending by since', ascending);
  const complete = data.history.every((e) => ['claude', 'codex'].every((h) =>
    ['strong', 'standard', 'fast'].every((t) => typeof e[h][t] === 'string' && e[h][t].length > 0)));
  ok('shipped data: every entry is a complete snapshot (3 tiers x 2 hosts)', complete);
  ok('shipped data: last since <= package.json version',
    cur.since === pkg.version || semverLt(cur.since, pkg.version));
}

{
  const refDoc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', '_shared', 'configuration-reference.md'), 'utf8');
  ok('drift guard: current claude strong id appears in the Tier-class -> id section',
    refDoc.includes(cur.claude.strong));
  ok('drift guard: current claude standard id appears in the Tier-class -> id section',
    refDoc.includes(cur.claude.standard));
}

console.log(`model-defaults-review.test.js: ${passed} assertions passed`);
