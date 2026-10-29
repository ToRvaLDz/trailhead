'use strict';
// Preflight dell'auth di gh (SessionStart): segnala una volta, all'avvio, un
// GH_TOKEN/GITHUB_TOKEN non valido nell'ambiente che oscura un login gh
// funzionante. Pura: il runner è iniettabile (spawnSync shape), i test non
// toccano mai la rete. Mai lancia: ogni errore o caso dubbio -> null.
const { spawnSync } = require('child_process');

// gh dà la precedenza a GH_TOKEN, poi GITHUB_TOKEN, poi al login salvato.
const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'];
// SessionStart scatta di nuovo su resume e compact: li saltiamo (una volta sola).
const SKIP_SOURCES = new Set(['resume', 'compact']);

// Budget totale condiviso da tutti i probe: SessionStart non resta bloccato oltre.
const BUDGET_MS = 5000;

function defaultRun(env, timeoutMs = BUDGET_MS) {
  try {
    return spawnSync('gh', ['api', 'user', '-q', '.login'], {
      env, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error };
  }
}

function activeVar(env) {
  return TOKEN_VARS.find((v) => typeof env[v] === 'string' && env[v] !== '') || null;
}

function isSuccess(r) {
  return Boolean(r) && !r.error && r.status === 0;
}
// Solo un 401 esplicito conta come rifiuto: tutto il resto (rete, timeout,
// gh assente) degrada in silenzio.
function isAuthFailure(r) {
  if (!r || r.error || r.status === 0 || r.status === null || r.status === undefined) return false;
  return /HTTP 401|Bad credentials/.test(String(r.stderr || '')) || /"status":\s*"401"/.test(String(r.stdout || ''));
}

// gh non loggato: exit 4 o invito a "gh auth login" (non un errore di rete).
function isNotLoggedIn(r) {
  if (!r || r.error) return false;
  return r.status === 4 || /gh auth login/.test(String(r.stderr || ''));
}

function notice(rejected, working) {
  const vars = rejected.join(' and ');
  const unset = rejected.map((v) => `${v}=`).join(' ');
  if (working === null) {
    return `GitHub rejects the ${vars} set in this environment (HTTP 401) and there is no working \`gh\` login. `
      + `Tell the user to remove ${rejected.length > 1 ? 'them' : 'it'} from their shell profile and run \`gh auth login\`.`;
  }
  const what = working === 'stored' ? 'the working `gh` login' : `the valid ${working}`;
  return `GitHub rejects the ${vars} set in this environment (HTTP 401); it overrides ${what}, so \`gh\` calls fail. `
    + `Tell the user to remove ${rejected.length > 1 ? 'them' : rejected[0]} from their shell profile and restart; `
    + `until then run \`gh\` as \`${unset} gh ...\`.`;
}

function check({ env, run, source, now } = {}) {
  try {
    if (SKIP_SOURCES.has(source)) return null;
    const base = env || process.env;
    if (!activeVar(base)) return null;
    const runner = run || defaultRun;
    let cur = { ...base };
    const rejected = [];
    const clock = now || Date.now;
    const start = clock();
    for (;;) {
      const remaining = BUDGET_MS - (clock() - start);
      if (remaining <= 0) return null;
      const r = runner(cur, remaining);
      if (isSuccess(r)) {
        return rejected.length ? notice(rejected, activeVar(cur) || 'stored') : null;
      }
      const active = activeVar(cur);
      // dopo un 401 confermato, senza altre variabili da togliere, anche "non
      // loggato" vale "nessun login funzionante"; rete/timeout restano silenziosi
      if (!active && rejected.length && (isAuthFailure(r) || isNotLoggedIn(r))) return notice(rejected, null);
      if (!isAuthFailure(r) || !active) return null;
      rejected.push(active);
      cur = { ...cur, [active]: '' };
    }
  } catch {
    return null;
  }
}

module.exports = { check, defaultRun };
