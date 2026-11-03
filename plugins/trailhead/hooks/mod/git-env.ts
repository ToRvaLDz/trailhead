// Leaf without imports: git argv for the mod's process spawns.
//
// Git gives the repo-location variables precedence over `-C` and the cwd, and
// `$.process.run` can only add or override env, never delete. So an inherited
// GIT_DIR would redirect every git spawn: wrap the argv in `env -u NAME ...`.
// The list is templates/trailhead-git-env.js's GIT_LOCATION_VARS (git rev-parse
// --local-env-vars minus GIT_CONFIG*); hooks/lib/git-env-mod.test.js keeps them equal.
export const GIT_LOCATION_VARS: readonly string[] = [
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
]

// `argv` run with the repo-location variables removed from its env.
export const scrubGitEnv = (argv: readonly string[]): string[] => [
  'env',
  ...GIT_LOCATION_VARS.flatMap(name => ['-u', name]),
  ...argv,
]

// `git <args>` that acts on the checkout it is pointed at (-C / cwd), never on an inherited GIT_DIR.
export const gitArgv = (...args: readonly string[]): string[] => scrubGitEnv(['git', ...args])
