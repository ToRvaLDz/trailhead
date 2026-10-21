// Foglia senza import, condivisa da work-state-locate e dal run autonomo: il parser di
// `git worktree list --porcelain` e il tetto dei fallimenti di fila.

// Quanti fallimenti di fila tengono l'ultimo risultato noto prima di azzerarlo.
export const MAX_FAILURES = 3

// Path and full branch ref of each checkout in `git worktree list --porcelain` (null: detached or bare).
export const parseWorktreeBranches = (porcelain: string): { path: string; branch: string | null }[] =>
  porcelain
    .split(/\n\s*\n/)
    .map(block => block.split('\n'))
    .filter(lines => lines.some(line => line.startsWith('worktree /')))
    .map(lines => {
      const path = (lines.find(line => line.startsWith('worktree ')) as string).slice('worktree '.length).replace(/(.)\/+$/, '$1')
      const branch = lines.find(line => line.startsWith('branch '))
      return { path, branch: branch === undefined ? null : branch.slice('branch '.length) }
    })
