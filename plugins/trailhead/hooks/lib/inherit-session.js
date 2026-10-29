'use strict';
// inherit-session.js: l'unico riconoscimento di "inherit session". #323.
// Modulo senza dipendenze (nessun fs/os/path/require): lo usano sia il router
// (model-route.js) e la review dei pin (model-defaults-review.js), sia la
// proiezione Codex (bin/lib/codex-projection.js), che deve restare pura.

const INHERIT_SESSION = 'inherit session';

// Vale per una stringa nuda o per il campo `model` di un pin a oggetto, senza
// badare a spazi e maiuscole.
function isInheritSession(v) {
  const isObject = !!v && typeof v === 'object' && !Array.isArray(v);
  const id = isObject ? v.model : v;
  return typeof id === 'string' && id.trim().toLowerCase() === INHERIT_SESSION;
}

module.exports = { isInheritSession, INHERIT_SESSION };
