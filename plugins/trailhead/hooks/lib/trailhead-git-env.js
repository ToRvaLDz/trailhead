'use strict';
// Repo-location environment for git spawns.
//
// Git gives these variables precedence over `-C` and the cwd, so an exported
// GIT_DIR (a hook, `git rebase --exec`, a parent shell) silently redirects every
// git call to another repository. Each git spawn in the plugin builds its env
// through gitEnv() so it always acts on the checkout it was pointed at.
//
// The names are `git rev-parse --local-env-vars` minus GIT_CONFIG*: those carry
// the parent's `-c` options and are meant to be inherited. A static list keeps
// this free of a git spawn; refresh it from that command when git adds a name.
// Names must be deleted: an empty string is not "unset" (`fatal: '' is not a git repository`).
//
// hooks/lib/trailhead-git-env.js is a byte-identical copy for the hooks (they
// install without the templates); a test keeps the two in sync.

const GIT_LOCATION_VARS = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

// A new env object: `base` without the repo-location names, then `extra` on top.
// Never mutates `base` (process.env by default).
function gitEnv(base = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(base)) if (!GIT_LOCATION_VARS.includes(k)) out[k] = v;
  return { ...out, ...extra };
}

module.exports = { GIT_LOCATION_VARS, gitEnv };
