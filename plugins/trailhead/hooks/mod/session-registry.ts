// Liveness di una sessione Claude Code dal registro del motore (<config>/sessions/<pid>.json,
// con `sessionId` e `pid`). Nessuna chiamata al motore qui: fs e controllo del pid sono iniettati.
// Il registro e' interno e non tipizzato, quindi ogni dubbio (cartella illeggibile, file non
// parsabile, registro vuoto) vale "unknown", mai "gone".

export type Liveness = 'live' | 'gone' | 'unknown'

export type RegistryDeps = {
  // I nomi dei file della cartella del registro; rifiuta se non si legge.
  list: (dir: string) => Promise<string[]>
  read: (path: string) => Promise<string>
  // true/false se il pid si sa vivo/morto, null se la piattaforma non lo dice (conta la sola presenza).
  pidAlive: (pid: number) => Promise<boolean | null>
}

type Entry = { sessionId: string; pid: number }

const parseEntry = (text: string): Entry | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.sessionId !== 'string' || r.sessionId === '') return null
  if (!Number.isInteger(r.pid) || (r.pid as number) <= 0) return null
  return { sessionId: r.sessionId, pid: r.pid as number }
}

export async function sessionLiveness(dir: string, sessionId: string, deps: RegistryDeps): Promise<Liveness> {
  let names: string[]
  try {
    names = (await deps.list(dir)).filter(name => name.endsWith('.json'))
  } catch {
    return 'unknown'
  }
  let parsed = 0
  let doubtful = false
  for (const name of names) {
    let entry: Entry | null = null
    try {
      entry = parseEntry(await deps.read(`${dir}/${name}`))
    } catch {
      entry = null
    }
    if (entry === null) {
      doubtful = true
      continue
    }
    parsed += 1
    if (entry.sessionId !== sessionId) continue
    let alive: boolean | null
    try {
      alive = await deps.pidAlive(entry.pid)
    } catch {
      alive = null
    }
    if (alive !== false) return 'live'
  }
  // Nessuna voce leggibile (la sessione corrente dovrebbe esserci) o file che non si leggono: non si sa.
  if (parsed === 0 || doubtful) return 'unknown'
  return 'gone'
}
