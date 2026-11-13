// git-globals.js: opzioni globali di git (usage line, git 2.49), UNICA fonte
// per trailhead-secret-read-guard.js e trailhead-commit-guard.js (#375).
// Un'opzione con valore consuma la parola successiva salvo forma
// `--opt=value`. Self-contained, nessuna dipendenza.

const GIT_GLOBAL_VALUE_OPTIONS = Object.freeze(new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']));
const GIT_GLOBAL_FLAGS = Object.freeze(new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--bare', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--exec-path', '--html-path', '--man-path', '--info-path',
]));
// Flag che accetta anche la forma `--opt=value` ma mai un valore separato.
const GIT_GLOBAL_EQ_FLAGS = Object.freeze(new Set(['--exec-path', '--list-cmds']));

// Un token è un'opzione con valore SEPARATO (la parola dopo è il suo valore)?
// `--opt=value` non consuma nulla.
function takesSeparateValue(tok) {
  return GIT_GLOBAL_VALUE_OPTIONS.has(tok);
}

module.exports = { GIT_GLOBAL_VALUE_OPTIONS, GIT_GLOBAL_FLAGS, GIT_GLOBAL_EQ_FLAGS, takesSeparateValue };
