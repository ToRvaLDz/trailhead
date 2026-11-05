// Leaf without imports: heredoc bodies out of a Bash command (#369).
//
// A heredoc body is data (a file being written), not commands, so a `gh issue close` line inside
// one is no tracker write. Only the opener line stays, with every body and terminator line dropped.
// The mod imports nothing from hooks/lib, so this is a small twin of shell-scan.js's
// stripHeredocBodies; hooks/lib/heredoc-mod.test.js keeps their output equal.
// When it cannot tell, a line is kept: a lost write leaves a stale pane, an extra read costs one `gh` call.

// The heredoc openers of one line, in order: [{ tag, isDash }]. A `<<` counts outside quotes and outside
// `((..))` arithmetic, and not as a here-string (`<<<`); an opener with no word after it is no opener.
function openersOf(line: string): Array<{ tag: string; isDash: boolean }> {
  const found: Array<{ tag: string; isDash: boolean }> = []
  let quote = ''
  let arith = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote !== '') {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '\\') {
      i++
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (line.startsWith('((', i)) {
      arith++
      i++
    } else if (arith > 0 && line.startsWith('))', i)) {
      arith--
      i++
    } else if (arith === 0 && line.startsWith('<<', i)) {
      if (line[i + 2] === '<') {
        i += 2
        continue
      }
      const isDash = line[i + 2] === '-'
      const word = /^\s*((?:\\.|'[^']*'|"[^"]*"|[^\s;&|<>()'"\\])+)/.exec(line.slice(i + (isDash ? 3 : 2)))
      if (word !== null) {
        found.push({ tag: word[1].replace(/\\(.)|['"]/g, '$1'), isDash })
        i += (isDash ? 3 : 2) + word[0].length - 1
      } else {
        i++
      }
    }
  }
  return found
}

// Every line from an opener to its terminator (the terminator included) goes; a body that never ends
// takes the rest of the command, as the shell reads it.
export function stripHeredocBodies(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i])
    for (const { tag, isDash } of openersOf(lines[i])) {
      while (i + 1 < lines.length) {
        i++
        if ((isDash ? lines[i].replace(/^\t+/, '') : lines[i]) === tag) break
      }
    }
  }
  return kept.join('\n')
}
