# ADR 0001 — Supporto multi-host: pattern GSD single-source + host-descriptor

Stato: **proposta** (in discussione)
Data: 2026-08-21

## Contesto

trailhead oggi è impacchettata come **plugin Claude Code** e dipende da primitive
proprie di quell'host:

- il `Skill` tool + auto-discovery di `SKILL.md`;
- i command wrapper `commands/*.md` con namespace `:` (`/trailhead:work`) e `$ARGUMENTS`;
- l'`Agent` tool per i subagent (research, review, codebase-map, plan, execute);
- il sistema di **hook** (PreToolUse/PostToolUse/SessionStart): secret-guard,
  commit-guard, injection-scanner, check-update;
- `${CLAUDE_PLUGIN_ROOT}`, `plugin.json`, marketplace.

Il **motore** invece è testo di prompt model-agnostic + `gh` CLI: `SKILL.md`, le
`references/`, e tutto ciò che vive sulle GitHub Issues sono già portabili così
come sono. La coppia da risolvere è quindi solo il **meccanismo di consegna** per
host diversi da Claude Code, a partire da **Codex CLI** (OpenAI).

## Prior art: come lo fa GSD

GSD non mantiene un port Codex separato. Ha un **adapter multi-host** che genera
gli artefatti nativi di ogni CLI da un'unica sorgente:

1. **Sorgente unica + proiezione all'install-time** (`runtime-artifact-conversion.cjs`):
   skill/command/agent scritti una volta, convertiti nel formato nativo dell'host
   quando si installa; un resolver runtime (`gsd_run`) fa girare i tool bash ovunque.
2. **Modello formale di Host Integration con assi chiusi** (`host-integration.cjs`):
   ogni host ha un **descrittore** con valori per asse presi dai docs di quella CLI,
   sentinel `undocumented` fail-closed, e una **degradation ladder**. Assi rilevanti:
   `commandSurface` (slash-file | slash-toml | palette | prose-only),
   `subagentToolkit` (full | read-only | built-in-only),
   `hookBus` (host | engine | none), `modelMode`, `isolation`, `effortSurface`.
3. **Rilevamento runtime** (`host-runtime-detection.cjs`): Codex via `CODEX_HOME`
   + marker `config.toml` e gli env `CODEX_SANDBOX*`.
4. **Degradazione, non blocco**: dove Codex manca una primitiva, GSD scala giù
   (es. wave parallele appiattite a sequenziali).

Concretizzazioni Codex di GSD (con file-prova):

| Pezzo Claude | Cosa fa GSD su Codex | File |
|---|---|---|
| Subagent (Agent tool) | genera `~/.codex/agents/<agent>.toml` (`model` + `model_reasoning_effort` + blocco `developer_instructions`) | `codex-agent-toml.cjs` |
| Nomi comando con `:` | li irattratina (`gsd-plan-phase`) — Codex non ha namespace `:` | `transformContentToHyphen` |
| Model split | strippa i nomi modello Anthropic dai toml (illegali su Codex) | `stripModel` |
| `Skill` tool | ogni agente self-load le sue skill via `gsd_run query agent-skills` nell'init | `agent-skills-bootstrap.md` |
| Hook | `hookBus` degradabile: Codex → niente hook lifecycle | `host-integration.cjs` |

## Decisione

Adottare lo **stesso pattern di GSD**, dimensionato a trailhead (molto più piccola):

- **Sorgente unica**: `SKILL.md` + `references/` restano la single source of truth
  del motore; i thin-wrapper per host (i `commands/*.md` di Claude oggi, i prompt
  Codex domani) sono **generati**, non scritti a mano né forkati.
- **Host-descriptor minimo**: un piccolo descrittore per host con gli assi che
  contano davvero per trailhead — `commandSurface`, `subagentToolkit`, `hookBus` —
  invece dell'intero framework GSD.
- **Degradazione esplicita**, non blocco, dove Codex manca una primitiva.

Mappature Codex per trailhead:

- **Command wrapper** `/trailhead:work` → prompt Codex irattratinati (`/trailhead-work`).
- **Subagent** → degradare a **inline sequenziale** (più semplice), oppure `agents/*.toml`
  se il fan-out diventa indispensabile. Si perde lo split modello per-attività e il
  fan-out parallelo del codebase-map.
- **`models.*` config** → risoluzione modello per-runtime, strippando i nomi Anthropic su Codex.
- **Skill tool** → i prompt Codex `@`-includono / inlineano `SKILL.md` + le `references/`.
- **I 4 hook** → `hookBus=none` su Codex → riportarli come **git pre-commit hook** o
  incorporare il check nel motore in prosa. **Questa è la perdita reale da mettere in conto.**
- **Detection** runtime: `CODEX_HOME` + `CODEX_SANDBOX*`.

## Questioni aperte (da decidere)

1. **Approccio A (lean single-agent) vs B (subagent via `codex exec`)**: iniziare con A?
2. **Host-descriptor**: file dati statico o modulo? Quanti assi al minimo?
3. **Hook persi su Codex**: git pre-commit hook, oppure check inline nel motore, o entrambi?
4. **Generazione wrapper**: build step a parte, o generati dall'installer `bin/trailhead.js`?
5. **Codex model config**: dove mappare `models.plan/execute/...` senza nomi Anthropic?

## Conseguenze

- **Pro**: nessun fork da mantenere; il motore evolve in un posto solo; Codex (e altri
  host poi) sono aggiunte di un descrittore + una proiezione, non riscritture.
- **Contro**: su Codex si perdono parallelismo dei subagent, split-modello per-attività,
  e i guardrail basati su hook (vanno riportati altrove).
