// Test helper: the mod runs git (and the gh of the map pane) as `env -u NAME ... <cmd>`
// (hooks/mod/git-env.ts); a process.run handler matches on the command itself.
export const unscrub = (argv: readonly string[]): string[] => {
  if (argv[0] !== 'env') return [...argv]
  let i = 1
  while (argv[i] === '-u') i += 2
  return argv.slice(i)
}
