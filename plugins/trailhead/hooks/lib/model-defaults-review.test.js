#!/usr/bin/env node
// Tests for model-defaults-review.js. Run: node model-defaults-review.test.js
// No framework: plain asserts, mirrors the style of gh-subcommand.test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Isola ogni caso dal vero CLAUDE_CONFIG_DIR dell'utente: senza questo, una
// review "global" potrebbe leggere davvero ~/.claude/trailhead/config.json.
// Ripristinato in fondo al file; i casi che puntano altrove salvano e
// ripristinano il valore corrente attorno a se stessi.
const PRIOR_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const BASE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-globalcfg-'));
process.env.CLAUDE_CONFIG_DIR = BASE_CONFIG_DIR;

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
  ack,
  effectiveModels,
  globalConfigDir,
  globalConfigFile,
  globalAckFile,
  readAckFile,
  writeAckFile,
  withImplicitGrill,
  isInheritSession,
} = require('./model-defaults-review.js');

const LIB_PATH = path.join(__dirname, 'model-defaults-review.js');

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
  ok('reviewNotice no longer claims the offer will not reappear once acknowledged',
    !reviewNotice(offer.stale, cur.since).includes('This offer will not reappear once acknowledged.'));
  ok('reviewNotice says the offer reappears until acknowledged',
    reviewNotice(offer.stale, cur.since).includes('reappears') || reviewNotice(offer.stale, cur.since).toLowerCase().includes('until'));
}

// --- fs round trip: check() is read-only --------------------------------------
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
  ok('findProjectRoot returns null with no project above', findProjectRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'th-noproj-'))) === null);

  ok('readAck is null before any ack is written', readAck(tmp) === null);

  const first = check(tmp);
  ok('check() returns a notice on first run', typeof first === 'string' && first.length > 0);
  ok('check() is read-only: writes no ack file', readAck(tmp) === null);
  ok('check() is read-only: writes no ack file on disk either', !fs.existsSync(path.join(tmp, '.trailhead', 'model-defaults-ack')));

  const second = check(tmp);
  ok('check() returns the same notice on a second run (still not acknowledged)', second === first);

  ok('the notice carries a ready-to-run ack instruction naming this lib and the project root',
    first.includes(`node "${LIB_PATH}" ack "${tmp}"`));
}

// --- ack(cwd) ------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-ack-'));
  fs.mkdirSync(path.join(tmp, '.trailhead'));
  fs.writeFileSync(path.join(tmp, '.trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  ok('check() returns a notice before ack()', typeof check(tmp) === 'string');

  const result = ack(tmp);
  ok('ack() returns true when it finds a project root', result === true);
  ok('ack() writes the current since as the ack', readAck(tmp) === cur.since);
  ok('check() returns null after ack()', check(tmp) === null);
}

{
  const noProj = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-ack-noproj-'));
  ok('ack() returns false with no project above cwd', ack(noProj) === false);
  ok('ack() never throws and writes nothing with no project above cwd',
    !fs.existsSync(path.join(noProj, '.trailhead')));
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

  const out = execFileSync('node', [LIB_PATH, 'check', tmp], { encoding: 'utf8' });
  ok('CLI check prints the notice to stdout', out.includes('models.plan: claude-opus-4-8 -> claude-opus-5-5'));
  ok('CLI check writes no ack file', !fs.existsSync(path.join(tmp, '.trailhead', 'model-defaults-ack')));

  const ackOut = execFileSync('node', [LIB_PATH, 'ack', tmp], { encoding: 'utf8' });
  ok('CLI ack prints nothing', ackOut === '');
  ok('CLI ack writes the ack file', readAck(tmp) === cur.since);

  const outAfterAck = execFileSync('node', [LIB_PATH, 'check', tmp], { encoding: 'utf8' });
  ok('CLI check prints nothing after CLI ack', outAfterAck === '');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-cli-unknown-'));
  let status = null;
  try {
    execFileSync('node', [LIB_PATH, 'bogus', tmp], { encoding: 'utf8' });
    status = 0;
  } catch (e) {
    status = e.status;
  }
  ok('CLI with an unknown subcommand still exits 0', status === 0);
}

// --- helper test-only: compatibilita' del `since` con la versione ------------
// Vero se base e' esattamente il prossimo bump patch, minor o major di current.
function isNextBump(current, since) {
  const [a, b, c] = current.split('.').map(Number);
  return [`${a}.${b}.${c + 1}`, `${a}.${b + 1}.0`, `${a + 1}.0.0`].includes(since);
}
function sinceCompatible(since, version) {
  return since === version || semverLt(since, version) || isNextBump(version, since);
}
ok('isNextBump accepts the next patch, minor and major of 0.11.1',
  ['0.11.2', '0.12.0', '1.0.0'].every((v) => isNextBump('0.11.1', v)));
ok('isNextBump rejects skipped bumps of 0.11.1',
  ['0.13.0', '1.12.0', '0.11.3', '0.12.1'].every((v) => !isNextBump('0.11.1', v)));

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
  // Il `since` dell'ultima entry puo' anticipare la release: uguale, piu' vecchio
  // o esattamente il prossimo bump patch/minor/major della versione corrente.
  ok('shipped data: last since matches or precedes package.json version (or is its next bump)',
    sinceCompatible(cur.since, pkg.version));
  const plugin = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  ok('shipped data: last since matches or precedes plugin.json version (or is its next bump)',
    sinceCompatible(cur.since, plugin.version));
}

{
  const refDoc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', '_shared', 'configuration-reference.md'), 'utf8');
  ok('drift guard: current claude strong id appears in the Tier-class -> id section',
    refDoc.includes(cur.claude.strong));
  ok('drift guard: current claude standard id appears in the Tier-class -> id section',
    refDoc.includes(cur.claude.standard));
  ok('drift guard: current claude fast id appears in the Tier-class -> id section',
    refDoc.includes(cur.claude.fast));
}

// --- default fast Haiku 5.5 dalla 0.12.0 -----------------------------------
ok('current claude fast default is claude-haiku-5-5', cur.claude.fast === 'claude-haiku-5-5');
ok('current opus/sonnet and codex tiers are unchanged',
  cur.claude.strong === 'claude-opus-5-5' && cur.claude.standard === 'claude-sonnet-5-5' &&
  cur.codex.strong === 'gpt-5.6-sol' && cur.codex.standard === 'gpt-5.6-terra' && cur.codex.fast === 'gpt-5.6-luna');

for (const old of ['claude-haiku-4-5-20251001', 'claude-haiku-4-5']) {
  const stale = stalePins({ models: { 'codebase-map': old } }, data);
  ok(`stale haiku pin ${old} detected`, stale.length === 1 &&
    stale[0].key === 'models.codebase-map' && stale[0].from === old && stale[0].to === 'claude-haiku-5-5');
}
ok('claude-haiku-5-5 itself is not stale',
  stalePins({ models: { 'codebase-map': 'claude-haiku-5-5' } }, data).length === 0);

{
  const config = { models: { 'codebase-map': 'claude-haiku-4-5-20251001' } };
  const offer = reviewOffer({ config, data, ack: '0.11.0' });
  ok('reviewOffer: ack 0.11.0 with a Haiku 4.5 pin -> offer naming 0.12.0 and the line',
    offer !== null && offer.notice.includes('0.12.0') &&
    offer.notice.includes('models.codebase-map: claude-haiku-4-5-20251001 -> claude-haiku-5-5'));
  ok('reviewOffer: ack 0.12.0 with a Haiku 4.5 pin -> null', reviewOffer({ config, data, ack: '0.12.0' }) === null);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-haiku-'));
  fs.mkdirSync(path.join(tmp, '.trailhead'));
  const cfgPath = path.join(tmp, '.trailhead', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ models: { 'codebase-map': 'claude-haiku-4-5-20251001' } }));
  const notice = check(tmp);
  ok('check(): a Haiku 4.5 project pin is listed with its project-config source',
    typeof notice === 'string' && notice.includes(
      `models.codebase-map: claude-haiku-4-5-20251001 -> claude-haiku-5-5 (new default; from the project config, ${cfgPath})`));
}

// --- #323: i pin grill sono valutati come ogni altra chiave (caratterizzazione) ---
{
  const config = { models: { grill: 'claude-opus-5', codex: { grill: { model: 'gpt-5.5-sol', effort: 'high' } } } };
  const stale = stalePins(config, data);
  ok('stale models.grill pin is flagged and updated to the strong default',
    stale.some((s) => s.key === 'models.grill' && s.from === 'claude-opus-5' && s.to === 'claude-opus-5-5'));
  const next = applyUpdate({ models: { grill: 'claude-opus-5' } }, stalePins({ models: { grill: 'claude-opus-5' } }, data));
  ok('applyUpdate rewrites models.grill', next.models.grill === 'claude-opus-5-5');
  const codexStale = stalePins({ models: { codex: { grill: { model: 'gpt-5.6-terra', effort: 'high' } } } }, data);
  ok('models.codex.grill at the current default is not flagged', codexStale.length === 0);
}

// --- #323: una config senza grill (chiave nata dopo) non genera nulla per grill ---
{
  const sevenOld = { plan: 'claude-opus-5-5', execute: 'claude-sonnet-5-5', research: 'claude-sonnet-5-5', review: 'claude-sonnet-5-5',
    debug: 'claude-sonnet-5-5', verify: 'claude-sonnet-5-5', 'codebase-map': 'claude-haiku-5-5',
    codex: { plan: { model: 'gpt-5.6-sol', effort: 'high' }, execute: 'gpt-5.6-terra' } };
  const cfg = { models: sevenOld };
  ok('seven old keys and no grill: no stale pin names grill', stalePins(cfg, data).every((s) => !/grill/.test(s.key)));
  ok('seven old keys at current defaults: the review offers nothing', reviewOffer({ config: cfg, data, ack: null }) === null);
  const stale = { models: { ...sevenOld, plan: 'claude-opus-5' } };
  const offer = reviewOffer({ config: stale, data, ack: null });
  ok('a stale plan pin is flagged but the notice never mentions grill', offer !== null && !offer.notice.includes('grill'));
  ok('applyUpdate does not invent a grill key', !('grill' in applyUpdate(stale, stalePins(stale, data)).models));
}

{
  const mod = require('./inherit-session.js');
  const src = fs.readFileSync(path.join(__dirname, 'inherit-session.js'), 'utf8');
  ok('inherit-session.js is dependency-free (no require)', !/require\(/.test(src));
  ok('model-defaults-review re-exports the same isInheritSession', mod.isInheritSession === isInheritSession);
  const projSrc = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'bin', 'lib', 'codex-projection.js'), 'utf8');
  ok('codex-projection requires the dependency-free module, not model-defaults-review',
    projSrc.includes("hooks/lib/inherit-session.js") && !projSrc.includes('model-defaults-review'));
  ok('isSkippable semantics: an inherit session pin is never flagged stale',
    stalePins({ models: { plan: ' Inherit Session ' } }, data).length === 0);
}

// --- #323: isInheritSession e' l'unico riconoscimento di "inherit session" ---
ok('isInheritSession: bare string, trimmed, any case',
  isInheritSession('inherit session') && isInheritSession('  Inherit Session ') && isInheritSession('INHERIT SESSION'));
ok('isInheritSession: the model field of an object pin', isInheritSession({ model: 'inherit session', effort: 'high' }) && isInheritSession({ model: ' Inherit Session' }));
ok('isInheritSession: real ids and non-strings are not inherit',
  !isInheritSession('gpt-5.6-sol') && !isInheritSession({ model: 'gpt-5.6-sol' }) && !isInheritSession(null) && !isInheritSession(undefined) && !isInheritSession({}) && !isInheritSession(3));

// --- #323: una layer che imposta plan ma non grill imposta grill = plan ---
{
  const src = { plan: 'p', codex: { plan: 'cp' }, execute: 'e' };
  const out = withImplicitGrill(src);
  ok('withImplicitGrill: plan without grill implies grill (claude and codex)', out.grill === 'p' && out.codex.grill === 'cp');
  ok('withImplicitGrill: does not mutate the input', !('grill' in src) && !('grill' in src.codex));
  ok('withImplicitGrill: an explicit grill is kept', withImplicitGrill({ plan: 'p', grill: 'g' }).grill === 'g');
  ok('withImplicitGrill: null or blank grill counts as unset', withImplicitGrill({ plan: 'p', grill: null }).grill === 'p' && withImplicitGrill({ plan: 'p', grill: ' ' }).grill === 'p');
  ok('withImplicitGrill: no plan, no implied grill', !('grill' in withImplicitGrill({ execute: 'e' })));
  ok('withImplicitGrill: a blank plan implies nothing', !('grill' in withImplicitGrill({ plan: '' })));
  ok('withImplicitGrill: inherit session plan implies an inherit grill', withImplicitGrill({ plan: 'inherit session' }).grill === 'inherit session');
  ok('withImplicitGrill: non-objects pass through', withImplicitGrill(null) === null && withImplicitGrill('x') === 'x');
  const stale = { models: { plan: 'claude-opus-5' } };
  ok('the pinned model review does not use the implicit grill', stalePins(stale, data).every((s) => s.key !== 'models.grill'));
}

// --- effectiveModels (pure merge, no mutation) --------------------------------
{
  const globalModels = { plan: 'g-plan', execute: 'g-exec', codex: { plan: { model: 'g-gpt', effort: 'high' } } };
  const projectModels = { plan: 'p-plan', codex: { plan: { model: 'p-gpt' } } };
  const layers = [
    { layer: 'global', file: '/g/trailhead/config.json', config: { models: globalModels } },
    { layer: 'project', file: '/p/.trailhead/config.json', config: { models: projectModels } },
  ];
  const { config, sources } = effectiveModels(layers);
  ok('effectiveModels: a project key wins over the global one', config.models.plan === 'p-plan');
  ok('effectiveModels: a global-only key survives when the project does not set it', config.models.execute === 'g-exec');
  ok('effectiveModels: a project codex key replaces the global one atomically (no inherited effort)',
    config.models.codex.plan.model === 'p-gpt' && config.models.codex.plan.effort === undefined);
  ok('effectiveModels: sources tags models.plan as the project layer',
    sources['models.plan'].layer === 'project' && sources['models.plan'].file === '/p/.trailhead/config.json');
  ok('effectiveModels: sources tags models.execute as the global layer',
    sources['models.execute'].layer === 'global' && sources['models.execute'].file === '/g/trailhead/config.json');
  ok('effectiveModels: sources tags models.codex.plan as the project layer',
    sources['models.codex.plan'].layer === 'project' && sources['models.codex.plan'].file === '/p/.trailhead/config.json');
  ok('effectiveModels does not mutate the input layer configs',
    globalModels.plan === 'g-plan' && projectModels.codex.plan.model === 'p-gpt' && !('effort' in projectModels.codex.plan));
}

{
  const layers = [
    { layer: 'global', file: '/g/config.json', config: { models: { plan: 'claude-opus-4-8' } } },
    { layer: 'project', file: '/p/config.json', config: { models: { plan: null } } },
  ];
  const { config, sources } = effectiveModels(layers);
  ok('effectiveModels: a project null value wins over global by own-key presence, not truthiness', config.models.plan === null);
  ok('effectiveModels: source for plan is the project even though its value is null', sources['models.plan'].layer === 'project');
}

{
  const layers = [
    { layer: 'global', file: '/g/config.json', config: { models: { plan: 'claude-opus-4-8' } } },
    { layer: 'project', file: '/p/config.json', config: { models: { plan: '' } } },
  ];
  const { config } = effectiveModels(layers);
  ok('effectiveModels: a project empty-string value wins over global by own-key presence', config.models.plan === '');
}

{
  const layers = [
    { layer: 'global', file: '/g/config.json', config: { models: { codex: { plan: { model: 'g-gpt' } } } } },
    { layer: 'project', file: '/p/config.json', config: { models: { codex: 'not-an-object' } } },
  ];
  const { config, sources } = effectiveModels(layers);
  ok('effectiveModels: a malformed project codex wins wholesale, yielding no codex pins', config.models.codex === 'not-an-object');
  ok('effectiveModels: a malformed project codex clears prior codex sources', !sources['models.codex.plan']);
}

{
  const layers = [{ layer: 'global', file: '/g/config.json', config: { models: null } }];
  const { config } = effectiveModels(layers);
  ok('effectiveModels: a layer whose models is not a plain object contributes nothing', Object.keys(config.models).length === 0);
}

// --- stalePins with a malformed codex value -------------------------------
ok('stalePins: a non-object models.codex yields no codex pins (not an exception)',
  stalePins({ models: { codex: 'oops' } }, data).length === 0);

// --- check()/ack(): global config merged under the project ---------------
{
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-global-'));
  process.env.CLAUDE_CONFIG_DIR = globalDir;
  fs.mkdirSync(path.join(globalDir, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-proj-empty-'));
  fs.mkdirSync(path.join(projectDir, '.trailhead'));
  fs.writeFileSync(path.join(projectDir, '.trailhead', 'config.json'), JSON.stringify({}));

  const notice = check(projectDir);
  ok('check(): a project with an empty config still flags a stale global pin',
    typeof notice === 'string' && notice.includes('models.plan: claude-opus-4-8 -> claude-opus-5-5'));
  ok('check(): the stale global pin line is tagged with the global config path',
    notice.includes(path.join(globalDir, 'trailhead', 'config.json')));

  process.env.CLAUDE_CONFIG_DIR = savedEnv;
}

{
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-global2-'));
  process.env.CLAUDE_CONFIG_DIR = globalDir;
  fs.mkdirSync(path.join(globalDir, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-proj-override-'));
  fs.mkdirSync(path.join(projectDir, '.trailhead'));
  fs.writeFileSync(path.join(projectDir, '.trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-5-5' } }));

  ok('check(): a project pin overriding a stale global pin is not flagged', check(projectDir) === null);

  process.env.CLAUDE_CONFIG_DIR = savedEnv;
}

{
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-global-only-'));
  process.env.CLAUDE_CONFIG_DIR = globalDir;
  fs.mkdirSync(path.join(globalDir, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  const noProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-noproj2-'));

  const notice = check(noProjDir);
  ok('check(): no project above cwd but a global config exists -> a notice',
    typeof notice === 'string' && notice.includes('models.plan: claude-opus-4-8 -> claude-opus-5-5'));
  ok('check(): the global-only case writes nothing', !fs.existsSync(path.join(globalDir, 'trailhead', 'model-defaults-ack')));

  const ackResult = ack(noProjDir);
  ok('ack(): the global-only case writes the global ack and returns true',
    ackResult === true && fs.existsSync(path.join(globalDir, 'trailhead', 'model-defaults-ack')));

  ok('check(): the global-only case is silenced after the global ack', check(noProjDir) === null);

  process.env.CLAUDE_CONFIG_DIR = savedEnv;
}

{
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-global-bad-'));
  process.env.CLAUDE_CONFIG_DIR = globalDir;
  fs.mkdirSync(path.join(globalDir, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), '{ not valid json');

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-proj-malformed-global-'));
  fs.mkdirSync(path.join(projectDir, '.trailhead'));
  fs.writeFileSync(path.join(projectDir, '.trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  const notice = check(projectDir);
  ok('check(): a malformed global config does not block the project review',
    typeof notice === 'string' && notice.includes('models.plan: claude-opus-4-8 -> claude-opus-5-5'));

  process.env.CLAUDE_CONFIG_DIR = savedEnv;
}

{
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-global-mixed-'));
  process.env.CLAUDE_CONFIG_DIR = globalDir;
  fs.mkdirSync(path.join(globalDir, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-proj-mixed-'));
  fs.mkdirSync(path.join(projectDir, '.trailhead'));
  fs.writeFileSync(path.join(projectDir, '.trailhead', 'config.json'), JSON.stringify({ models: { execute: 'claude-sonnet-5' } }));

  const notice = check(projectDir);
  const globalConfigPath = path.join(globalDir, 'trailhead', 'config.json');
  const projectConfigPath = path.join(projectDir, '.trailhead', 'config.json');
  ok('check(): mixed sources - the global stale key is tagged with the global config path',
    notice.includes(`models.plan: claude-opus-4-8 -> claude-opus-5-5 (new default; from the global config, ${globalConfigPath})`));
  ok('check(): mixed sources - the project stale key is tagged with the project config path',
    notice.includes(`models.execute: claude-sonnet-5 -> claude-sonnet-5-5 (new default; from the project config, ${projectConfigPath})`));

  process.env.CLAUDE_CONFIG_DIR = savedEnv;
}

// --- CLI check/ack honouring CLAUDE_CONFIG_DIR ----------------------------
{
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-cli-global-'));
  fs.mkdirSync(path.join(globalDir, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  const noProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-cli-noproj-'));

  const out = execFileSync('node', [LIB_PATH, 'check', noProjDir], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: globalDir },
  });
  ok('CLI check with CLAUDE_CONFIG_DIR set flags a global-only stale pin',
    out.includes('models.plan: claude-opus-4-8 -> claude-opus-5-5'));

  const ackOut = execFileSync('node', [LIB_PATH, 'ack', noProjDir], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: globalDir },
  });
  ok('CLI ack with CLAUDE_CONFIG_DIR set writes the global ack',
    ackOut === '' && fs.existsSync(path.join(globalDir, 'trailhead', 'model-defaults-ack')));
}

// --- host-aware command form e global config (Codex) --------------------
{
  const stale = [{ key: 'models.plan', from: 'claude-opus-4-8', to: 'claude-opus-5-5' }];
  const codexNotice = reviewNotice(stale, cur.since, 'codex');
  const claudeNotice = reviewNotice(stale, cur.since, 'claude');
  ok('reviewNotice(codex) names $trailhead config', codexNotice.includes('open $trailhead config'));
  ok('reviewNotice(codex) never names the Claude slash form', !codexNotice.includes('/trailhead:'));
  ok('reviewNotice(claude) names /trailhead:config', claudeNotice.includes('open /trailhead:config'));
  ok('reviewNotice default host is claude outside an installed Codex path',
    reviewNotice(stale, cur.since).includes('/trailhead:config'));
}

{
  // Lib copiata sotto un finto <codexHome>/skills/trailhead/hooks/lib/: l'host
  // si deduce dal path, senza env, e la config globale e' <codexHome>/trailhead/.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-codexhome-'));
  const libDir = path.join(codexHome, 'skills', 'trailhead', 'hooks', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  for (const f of ['model-defaults-review.js', 'model-defaults.json', 'inherit-session.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(libDir, f));
  }
  fs.mkdirSync(path.join(codexHome, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'trailhead', 'config.json'), JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));
  const noProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-mdr-codex-noproj-'));
  const copied = path.join(libDir, 'model-defaults-review.js');

  const out = execFileSync('node', [copied, 'check', noProjDir], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: BASE_CONFIG_DIR, CODEX_HOME: '' },
  });
  ok('Codex path: check() honours <codexHome>/trailhead/config.json', out.includes('models.plan: claude-opus-4-8 -> claude-opus-5-5'));
  ok('Codex path: the notice offers $trailhead config', out.includes('open $trailhead config'));
  ok('Codex path: the notice never names /trailhead:', !out.includes('/trailhead:'));
  ok('Codex path: the notice tags the Codex global config path',
    out.includes(path.join(codexHome, 'trailhead', 'config.json')));

  execFileSync('node', [copied, 'ack', noProjDir], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: BASE_CONFIG_DIR, CODEX_HOME: '' },
  });
  ok('Codex path: the global ack lands under <codexHome>/trailhead/',
    fs.existsSync(path.join(codexHome, 'trailhead', 'model-defaults-ack')));

  const mod = require(copied);
  ok('Codex path: globalConfigDir resolves to the codexHome', mod.globalConfigDir() === codexHome);
  ok('Codex path: check() is silenced after the Codex global ack', mod.check(noProjDir) === null);
  ok('Claude behaviour unchanged: globalConfigDir still follows CLAUDE_CONFIG_DIR',
    globalConfigDir() === BASE_CONFIG_DIR);
}

console.log(`model-defaults-review.test.js: ${passed} assertions passed`);

if (PRIOR_CLAUDE_CONFIG_DIR === undefined) {
  delete process.env.CLAUDE_CONFIG_DIR;
} else {
  process.env.CLAUDE_CONFIG_DIR = PRIOR_CLAUDE_CONFIG_DIR;
}
