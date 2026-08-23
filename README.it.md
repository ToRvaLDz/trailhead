<div align="center">

# Trailhead

🇬🇧 [English](README.md) · 🇮🇹 **Italiano**

[![npm](https://img.shields.io/npm/v/@marcomigozzi/trailhead?style=flat-square&label=npm&color=CB3837)](https://www.npmjs.com/package/@marcomigozzi/trailhead) [![license](https://img.shields.io/github/license/ToRvaLDz/trailhead?style=flat-square&color=3C7A5A)](LICENSE) ![host](https://img.shields.io/badge/host-Claude%20Code%20%C2%B7%20Codex-1E2A54?style=flat-square) ![comandi](https://img.shields.io/badge/comandi-20%20verbi-0e8a16?style=flat-square) ![guardrail](https://img.shields.io/badge/guardrail-4%20hook-e8710a?style=flat-square)

</div>

**Avvia e conduci grandi progetti come una mappa di ticket su GitHub Issues, risolvendone uno alla volta finché la via verso la destination non è chiara.**

`trailhead` è una skill orchestratrice per coding agent, che gira su [Claude Code](https://docs.claude.com/en/docs/claude-code) e [Codex CLI](https://developers.openai.com/codex/cli) da un'unica sorgente. Dà a un'idea grande e nebbiosa un punto da cui partire (un *trailhead*) e un modo disciplinato per portarla fino a un risultato funzionante, con l'intero piano che vive sul tuo issue tracker invece che in file locali sparsi.

---

## 💡 Perché esiste trailhead

Due approcci al lavoro di progetto guidato dagli agenti risolvono ciascuno una metà del problema:

- **[Wayfinder](https://github.com/mattpocock/skills)** (di Matt Pocock) è brillante nell'*iniziare*. Trasforma un'idea informe in una **mappa condivisa di decision ticket sul tuo issue tracker**, denominati attraverso una vera conversazione di grilling, con una frontier visibile e una "fog of war" per ciò che non è ancora abbastanza nitido da pianificare. Risolvi una decision per sessione e la mappa cresce verso l'esterno. Ciò che deliberatamente non fa è *costruire*: pianifica, poi passa la mano (handoff).

- **GSD** (il workflow system [open-gsd](https://github.com/open-gsd/gsd-core)) è brillante nel *fare*. Il suo ciclo `discuss → plan → execute → verify`, i commit atomici e la cattura senza attrito rendono la costruzione vera e propria affidabile e revisionabile. Ma il suo stato vive in un albero locale `.planning/`, separato da dove il team può vederlo.

Lavorando su entrambi, uno schema continuava a ripresentarsi: **usa una mappa e un onboarding in stile Wayfinder per decidere la forma del lavoro, poi un motore in stile GSD per costruire ogni pezzo, senza mai lasciare l'issue tracker.** `trailhead` è quello schema trasformato in un'unica skill, una sua interpretazione autonoma di entrambe le idee anziché un wrapper attorno all'una o all'altra.

> **trailhead è self-contained.** Wayfinder e GSD sono *ispirazione*, non dipendenze. Ogni tecnica che quei sistemi impacchettano come skill separata (grilling, TDD, debugging sistematico, codebase mapping, code review) è **integrata qui come protocollo inline**. Il core di trailhead non invoca nessun'altra skill; i suoi subagent (research, codebase-map, review) usano i subagent nativi dell'host (il tool `Agent` integrato di Claude Code, oppure il toolkit `multi_agent` di Codex). L'unica cosa da installare è trailhead stesso. C'è un'unica eccezione opt-in: quando abilitata, la modalità mockup di `claude.ai/design` crea il mockup su claude.ai/design via l'MCP ufficiale Claude Design di Anthropic, su un progetto canvas per default o, per una libreria di componenti condivisa, un progetto design-system tramite DesignSync (l'MCP `claude-design` più la skill `/design-sync`). Se questa non è disponibile, ripiega silenziosamente sui mockup su disco locale.

Le scelte di design che ne derivano:

- **Tutto vive su GitHub Issues.** La mappa è la parent issue; ogni ticket è una child issue; discussione, piano e verifica sono *commenti*. Non c'è alcuna directory `.planning/`: il repo contiene solo codice, e il piano è sempre visibile a chiunque abbia accesso al repo.
- **L'esecuzione avviene dentro la mappa.** A differenza del Wayfinder puro ("plan, don't do"), i build ticket si diplomano dalla fog e vengono eseguiti come figli della mappa. La destination è l'**artefatto funzionante** (un'app deployata), non un documento di specifica, anche se un progetto può ridefinire questo e fermarsi alla specifica.
- **Lean by default.** Il macchinario pesante (codebase mapping, debugging sistematico) gira una volta dove vale la pena; il ciclo per-ticket resta leggero.

- **Costruito per i team, perché il piano è condiviso.** Il tracker è l'unica fonte di verità, quindi la mappa è un **workspace condiviso**, non il file locale di una singola persona. Molte persone (e i loro agenti) ci lavorano contemporaneamente, e i meccanismi impediscono che si scontrino:
  - **Claiming.** Prendi un ticket assegnandolo a te stesso; l'assegnatario *è* il lock. Una collisione ti ferma e chiede, invece di sovrascrivere il lavoro di qualcun altro. Chi rivendica un ticket lo possiede dall'inizio alla fine e lo chiude, senza un approvatore separato.
  - **Una frontier condivisa, un ticket per sessione.** La **frontier** (ticket aperti, non assegnati, non bloccati) è la coda comune di ciò che è prendibile ora; ognuno ne sceglie uno diverso. Risolvere un ticket termina la sessione, così il lavoro resta in porzioni revisionabili, un ticket alla volta.
  - **Isolation per sessioni concorrenti su una macchina.** Due agenti che modificano un unico checkout si corrompono a vicenda, quindi la convenzione `isolation:` dà a ogni ticket in corso il proprio **`git worktree`** (o un intero **`clone`** per le app legate a un path che un worktree non riesce a buildare); righe `Scope:` disgiunte lasciano girare in parallelo lavori non sovrapposti e serializzano solo dove c'è vera sovrapposizione.
  - **Pause, resume, split.** Qualsiasi ticket può essere messo in **pause** con un commento di checkpoint e **ripreso** più tardi da chiunque (una volta rilasciato), o **splittato** in figli quando supera la dimensione di una sessione, con i blocker ripuntati così la frontier resta onesta.
  - **Più mappe insieme.** Un repo può portare **più di una mappa attiva** (milestone o feature parallele), ciascuna con la propria frontier con scope, così due persone possono condurre due sforzi sullo stesso repo senza pestarsi i piedi, e puoi parcheggiare una mappa per lavorarne un'altra.
  - **Esterni e fiducia.** Le issue aperte da altre persone passano attraverso una **inbox** che riformula quelle valide in ticket *sul posto* (mantenendo l'autorialità di chi ha segnalato), mentre una guardia di **trust e provenance** mette in quarantena le issue etichettate `trailhead:*` da fonti non fidate finché un maintainer non le adotta, supportata da un workflow di label-guard lato repo.

  Il protocollo completo vive nella sezione **Lavorare in team** più sotto.

---

## 📦 Install

> **Gira su Claude Code e Codex CLI.** trailhead è scritto una volta sola; l'installer proietta artefatti nativi per l'host. Su **Claude Code**: una skill + comandi `/trailhead:*` + hook. Su **Codex CLI**: una skill nativa invocata `$trailhead`, una skill `$trailhead-<verb>` per ogni verbo per la discoverability, e le guardrail come hook nativi di Codex. Scegli l'host con `--claude` / `--codex`, o lascia che l'installer lo rilevi da solo. Altri host possono seguire (l'installer usa un descrittore per-host).

**Prerequisiti:** una [`gh` CLI](https://cli.github.com) autenticata (il tracker è GitHub Issues) e un repo GitHub in cui lavorare. Il percorso npm richiede anche Node 18+.

### Come plugin Claude Code (nativo, gestito da `/plugin`)
```
/plugin marketplace add ToRvaLDz/trailhead
/plugin install trailhead@trailhead
```
Aggiorna con `/plugin update trailhead`; rimuovi con `/plugin uninstall trailhead`.

### Oppure via npm (installa nella config dir del tuo agente)
```
npx @marcomigozzi/trailhead              # rileva l'host (default ~/.claude)
npx @marcomigozzi/trailhead --claude     # Claude Code (~/.claude o $CLAUDE_CONFIG_DIR)
npx @marcomigozzi/trailhead --codex      # Codex CLI ($CODEX_HOME o ~/.codex)
npx @marcomigozzi/trailhead --symlink    # dev install (Claude; symlink al checkout, le modifiche sono live)
npx @marcomigozzi/trailhead --uninstall  # rimuove tutto ciò che ha aggiunto (abbinalo a --claude / --codex)
npx @marcomigozzi/trailhead --dir=<path> # punta a una config dir specifica
```
Su **Claude Code** copia la skill (+ le sue `references/`), i comandi `/trailhead:*`, gli hook (in `hooks/`, registrati in `settings.json`) incluso un **update check** al SessionStart, e i template di label-guard + statusline, in modo idempotente.

Su **Codex CLI** (`--codex`) proietta una skill nativa Codex invocata come **`$trailhead`** (`$trailhead work`, `$trailhead new "idea"`, …), una skill sottile **`$trailhead-<verb>`** per ogni verbo per la discoverability, le quattro guardrail come **hook** nativi di Codex (`~/.codex/hooks.json`, abilitando `features.hooks`), e i pin di modello per-tecnica da **`models.codex.*`** in `~/.codex/agents/`. Serve Codex **0.145.0+** (l'installer fa un gate su `codex --version`). La modalità mockup `claude.ai/design` non è disponibile su Codex, quindi lì i mockup UI ripiegano sul disco locale.

Ri-esegui l'install per aggiornare, oppure esegui **`/trailhead:update`** (Claude) / **`$trailhead update`** (Codex) da dentro l'agente: rileva come trailhead è stato installato e installa la versione più recente dove è sicuro farlo (un `git pull` per un dev-symlink, una ri-esecuzione `npx` per npm, o `/plugin update` per il plugin). Quando esiste una versione più recente, la statusline mostra un flag `⬆ trailhead <version>` (Claude).

### Dopo l'installazione
Riavvia o ricarica il tuo agente così i comandi si registrano, poi esegui **`/trailhead`** per iniziare (smart entry), o `/trailhead:new "<idea>"` per tracciare una mappa. **Su Codex** la superficie è `$trailhead`: esegui **`$trailhead`** per lo smart entry, `$trailhead new "<idea>"` per tracciare, o una skill per-verbo `$trailhead-<verb>`. Nota: una volta installato, l'**hook di commit guard gira a ogni `git commit`** (imponendo i Conventional Commits e bloccando `Co-Authored-By`); disabilita gli hook del plugin nelle impostazioni se non lo vuoi. In ogni caso trailhead è self-contained: nessun'altra skill o plugin è richiesta, niente preflight, niente version drift.

---

## 🗺️ Come funziona

Una **map** è una singola issue GitHub etichettata `trailhead:map`. È un indice, non un archivio: una Destination, delle Notes permanenti, i `Decisions so far`, la fog `Not yet specified`, e ciò che è `Out of scope`.

**Cosa merita una mappa?** Una mappa è l'unità per uno sforzo che è **troppo grande da tenere in una sola sessione** e porta con sé **decisioni aperte**, non solo esecuzione. In pratica è una **milestone** (una release, una versione, "v2 della dashboard"), o una **singola feature abbastanza grande da dover decidere prima di poter costruire**: dove vivono i dati, quale libreria, cosa fa davvero la schermata. Tracciare una mappa dà un nome alla sua destination e dirama quello sforzo in molti ticket, cablati dalle loro dipendenze. Man mano che le decisioni si risolvono, la fog si dirada e i build ticket si diplomano, finché la destination non è raggiunta.

Ciò che **non** ha bisogno di una propria mappa è un singolo pezzo di lavoro definito senza domande aperte, abbastanza piccolo da finire in una sessione. Quello è semplicemente **un ticket**, un `build` diretto (o un `todo`): un *work* che prendi con `/trailhead:work` e risolvi in una seduta, senza bisogno di tracciare. **Regola pratica: decisioni da prendere, o troppo grande per una seduta → una mappa; "fai solo X" → un singolo work.** Una feature che nasce come un work isolato ma si scopre aver bisogno di decisioni viene promossa a una propria mappa (o splittata); una mappa le cui domande evaporano tutte collassa di nuovo in una manciata di work. E un repo può contenere **più mappe insieme** (milestone o feature parallele), ciascuna con la propria frontier, così puoi parcheggiarne una e lavorarne un'altra.

Ogni **ticket** è una child issue con una label di tipo e un corpo di una sola domanda. La **frontier** è l'insieme dei ticket aperti, non assegnati, i cui blocker sono tutti chiusi: ciò che è prendibile proprio ora. Rivendichi un ticket assegnandolo a te stesso, lo risolvi con il motore per il suo tipo, poi registri la risposta come commento, lo chiudi, e ne fai il gist di nuovo sulla mappa.

Man mano che i ticket si risolvono, la fog si dirada: domande che erano troppo vaghe da formulare diventano abbastanza nitide da diventare ticket, una alla volta, finché non resta nulla da decidere o costruire e la destination è raggiunta.

Una mappa ha come scope **un** solo sforzo, quindi la conoscenza che appartiene al *repo* (non a una singola mappa) vive in **anchor issue con scope di repo**, create una volta e condivise da ogni mappa (le Notes di ciascuna mappa le collegano soltanto, così nulla resta orfano quando una mappa finisce):

- **`trailhead:codebase`**: la codebase map distillata (architettura, stack, convenzioni, rischi, test/build), scritta una volta all'adopt e aggiornata solo su drift importanti.
- **`trailhead:conventions`**: il **modo di lavorare** del progetto, leggibile da tutti: un piccolo header machine-read che il motore obbedisce (`git: main|pr`, `release: command|auto`, `isolation: none|worktree|clone`) sopra la prosa umana. `/trailhead:adopt` e `:new` lo chiedono all'inizio. `isolation: worktree` dà a ogni ticket in esecuzione il proprio `git worktree` + branch (le sessioni concorrenti su un clone non condividono mai un working tree); `isolation: clone` gli dà invece un clone dedicato, per le app legate a un path che un worktree non riesce a buildare.
- **`trailhead:dashboard`**: l'indice pinnato dell'intera superficie, un link a ogni mappa aperta (con le progress bar native di GitHub), la whiteboard, e conteggi live (inbox, frontier della whiteboard). Aggiornato quando una mappa viene tracciata o esaurita, quando un ticket della whiteboard nasce o si risolve (non ha una progress bar nativa, quindi la dashboard è l'unico posto in cui appare), e su richiesta via `/trailhead:dashboard`.

Questi tre riempiono i **3 slot di issue pinnate** di GitHub, così gli anchor di trailhead di un repo restano a un click di distanza; **le mappe stesse non vengono mai pinnate** (sono indicizzate dalla dashboard, dato che la mappa "attiva" è stato locale per-checkout, non un fatto globale del repo). La *config* del progetto (models, TDD, design…) è ancora una cosa separata, un semplice file `.trailhead/config.json` alla radice del repo, mai in una issue.

---

## 🔄 Workflow

**Il ciclo di vita.** Ogni progetto percorre lo stesso loop:

1. **Start**: `/trailhead:new "<idea>"` (greenfield) o `/trailhead:adopt` (codice esistente: mappa la codebase una volta, poi vai lean). Questo *traccia la mappa*: dai un nome alla destination, poi mappa la frontier in ampiezza (breadth-first) nei primi ticket e nella fog.
2. **Lavora la frontier, un ticket per sessione**: `/trailhead:work` prende il prossimo ticket prendibile (o quello che nomini) ed esegue il motore per il suo tipo: `research` raccoglie un fatto · `decision` dirama le opzioni poi fa grilling per scegliere · `prototype` crea un artefatto grezzo a cui reagire · `build` esegue discuss → plan → execute → verify · `bug` esegue repro → diagnose → fix → verify · `task` è plumbing manuale che sblocca una decision.
3. **Chiudi e sblocca**: risolvi il ticket (commento + chiusura), fanne il gist in `Decisions so far`, e rimuovi `trailhead:blocked` da ogni dipendente il cui ultimo blocker si è appena chiuso, diplomandolo sulla frontier.
4. **Ripeti** finché la frontier è vuota e la fog si è diradata: la destination (un artefatto funzionante) è raggiunta.

Lungo il cammino: **cattura** idee in corso d'opera senza deragliare, **splitta** un ticket cresciuto troppo, **pause/resume** tra le sessioni, e lascia che più persone lavorino in parallelo i ticket sbloccati.

### Un esempio pratico: "add social login"

Destination: *gli utenti accedono con Google e GitHub, accanto a email/password.* Il charting la dirama in sei ticket (uno per ogni tipo) cablati dalle loro dipendenze:

```
① research   "OAuth providers + library: Supabase Auth native or Auth.js?"   ← frontier (AFK)
② decision   "approach: Supabase Auth native vs Auth.js custom"              ← blocked by ①
③ task       "register OAuth apps on Google + GitHub, get client id/secret"  ← frontier (HITL)
④ prototype  "how the login screen with social buttons looks"                ← frontier (HITL)
⑤ build      "implement Google + GitHub login"                               ← blocked by ②③④
⑥ bug        (appears after ⑤ ships)
```

Frontier iniziale = ①③④, tre persone possono partire in parallelo. Poi:

- **① research** → un subagent legge la documentazione, restituisce un finding pronto per la decisione, chiude → sblocca ②.
- **② decision** → dirama le opzioni, grill per scegliere native vs custom, registra il perché.
- **③ task** → l'agente ti consegna una checklist (servono i *tuoi* account Google/GitHub); tu registri le app, lui registra dove vivono le credenziali.
- **④ prototype** → una schermata di login grezza (sul progetto claude.ai/design configurato), approvata prima del codice UI.
- Con ②③④ chiusi, **⑤ build** si diploma → discuss → plan → execute (commit atomici, TDD ai seam dell'auth) → verify (test + code review + acceptance: l'agente guida il browser attraverso il vero flusso di login).
- Dopo il rilascio noti un redirect sbagliato in prod → `/trailhead:bug --of ⑤ "GitHub redirect goes to localhost"` → un nuovo ticket che porta `Regression of: ⑤`, lavorato repro → diagnose → fix → verify. ⑤ resta chiuso.

```
① research ─┐
③ task ─────┼─► ② decision ─┐
④ prototype ┘                ├─► ⑤ build ──(ship)──► ⑥ bug (Regression of: ⑤)
③ task ──────────────────────┘
```

I tipi preparatori (`research`/`decision`/`prototype`/`task`) sbloccano quelli costruttivi (`build`/`bug`); il parallelismo è reale ma tra sessioni sulla frontier, non dentro una sola.

### …poi arriva un suggerimento: inbox → fog → graduation

L'app è live, e un utente *non del team* apre una issue normale: *"can we add Apple sign-in too?"* Nessuna label `trailhead:*`, quindi non è ancora un ticket. Ecco come una voce esterna diventa un ticket di prima classe sulla mappa, senza perdere l'autorialità di chi ha segnalato:

1. **Inbox**: `/trailhead:inbox` la elenca sotto *New: to triage*. È in scope ma non nitida: solo web o nativo? serve l'account Apple Developer a pagamento? Non puoi ancora formulare una singola Question a cui si possa rispondere, quindi non forzi un ticket.
2. **Fog**: etichettala `trailhead:fog` e **tieni la issue aperta come spazio di chiarimento**. Un commento pubblica le domande di affinamento (grilling asincrono); chi ha segnalato e chiunque interessato la affinano nel thread. È fuori dalla frontier ma tracciata: `gh issue list --label trailhead:fog` è la lista durevole, e chi ha segnalato segue la propria issue.
3. **Graduation**: la discussione converge. La prossima volta che esegui `/trailhead:inbox`, la sua sezione *Parked fog* fa emergere il thread come recentemente-attivo: è così che noti che la fog si è diradata. Ora la Question è formulabile, quindi la **adotti sul posto**: sostituisci `trailhead:fog` con `trailhead:ticket` + una label di tipo, aggiungi la riga `Parent:` e la `## Question`. Stesso numero di issue, stesso reporter accreditato, atterra sulla frontier, pronta per `/trailhead:work`.

```
suggestion issue ──inbox──► 🌫️ fog (kept open, discussed) ──sharpens──► 🎫 ticket on the frontier
                                                                       (same #, reporter still credited)
```

Nessun backlog separato, nessun credito perso: la mappa assorbe i suggerimenti esterni allo stesso modo in cui fa crescere i propri, attraverso una fog che si diploma quando è nitida.

---

## ⌨️ Commands

`trailhead` è invocato dall'utente (non si attiva da solo). La **prima parola** è il verbo; il resto è testo o un numero di ticket. Senza verbo, `/trailhead` fa **smart entry**: ispeziona il repo e propone la mossa giusta successiva.

Ogni verbo è anche un comando con namespace (`/trailhead:new`, `/trailhead:work`, `/trailhead:bug`, …) così digitando `/trailhead` li elenca tutti nel command picker. `/trailhead <verb>` e `/trailhead:<verb>` sono equivalenti.

### Flow

| Command | Cosa fa |
|---|---|
| `/trailhead` | smart entry: rileva lo stato e propone |
| `/trailhead:new [idea]` | traccia una nuova mappa da un'idea informe |
| `/trailhead:adopt` | adotta un progetto esistente (mappa la codebase una volta, poi vai lean) |
| `/trailhead:work [ticket]` | lavora il prossimo ticket della frontier, o quello che nomini |
| `/trailhead:quick [ticket \| "text"]` | lavora un ticket per intero, fuori dalla mappa: apre un ticket della whiteboard da `"text"` (o prende `<n>`), esegue il motore completo, fa grilling solo se serve, non splitta mai |
| `/trailhead:whiteboard` | mostra la whiteboard: i ticket sciolti (senza mappa) e la loro frontier |
| `/trailhead:inbox [issue]` | fa il triage delle issue aperte da altri e integra quelle buone nella mappa |
| `/trailhead:resume [ticket]` | riprende un ticket in pausa dal suo checkpoint `PAUSED` |
| `/trailhead:pause [note]` | mette un checkpoint sul ticket in gioco così chiunque può riprenderlo |
| `/trailhead:ticket <type> <title>` | apre un ticket al volo (diverge brevemente prima: un atto di micro-charting) |
| `/trailhead:split [ticket]` | splitta un ticket sovradimensionato in figli, supersede l'originale |
| `/trailhead:grill [topic]` | esegue una sessione di grilling autonoma su una decision/topic |
| `/trailhead:map` | mostra la mappa a bassa risoluzione (destination, decisions, frontier, fog) |
| `/trailhead:dashboard` | mostra la dashboard del repo: l'indice pinnato di ogni mappa aperta, la whiteboard, e i conteggi live |

### Capture: zero attrito, una riga di conferma, non risolve nulla

| Command | Atterra come | Significato |
|---|---|---|
| `/trailhead:todo <text>` | un ticket sulla frontier | *lo sto facendo*: lavoro definito, ora |
| `/trailhead:seed <text>` | un ticket bloccato (trigger annotato) | *lo farò quando X accade* |
| `/trailhead:idea <text>` | la fog (`Not yet specified`) | *forse lo farò*: si diploma a ticket se si affina |
| `/trailhead:note <text>` | testo verbatim | *ricorda questo*: non necessariamente lavoro |
| `/trailhead:bug [--of <ticket>] <text>` | un ticket `bug` | un difetto; `--of` lo registra come `Regression of:` di un ticket chiuso |

Le quattro capture fog/ticket formano uno spettro di impegno e tempistica: **note < idea < seed < todo**.

Quando una mappa è aperta, una capture che produce un ticket (`todo`/`bug`/`seed`/un `idea` nitido) chiede se depositarlo sulla **mappa attiva** o sulla **whiteboard**, la casa per il lavoro sciolto, senza mappa, che non appartiene a nessuna mappa (o non vale la pena tracciarne una). Senza mappa aperta atterra sulla whiteboard. Lavora un ticket della whiteboard con **`/trailhead:quick`** (che ne apre anche uno da `"text"` e lo lavora nella stessa seduta), e vedili tutti con `/trailhead:whiteboard`.

### 🧯 Non restare intrappolato in una mappa: la whiteboard

In profondità dentro una mappa, emerge qualcosa di non correlato: un bug in un'altra area, una faccenda, un'idea veloce su cui vuoi agire adesso. Forzarla sulla frontier della mappa inquina la mappa; tracciare un'intera nuova mappa per essa è eccessivo. È a questo che serve la **whiteboard**, il lavoro sciolto senza mappa, e due mosse ti impediscono di restare bloccato:

- **Mettila da parte.** Un `todo`/`bug`/`seed`/`idea` nitido lanciato mentre una mappa è aperta chiede *mappa o whiteboard?*. Mandala alla whiteboard e resta fuori dalla mappa: tracciata, ma fuori dai piedi, così la frontier della mappa continua a significare "la via verso questa destination".
- **Fallo al volo.** `/trailhead:quick "<text>"` apre un ticket della whiteboard e lo lavora dall'inizio alla fine nella stessa seduta, il motore completo discuss → plan → execute → verify (commit atomici, code review, tutto quanto), tranne che **fa grilling solo se serve e non splitta mai**, e salta ogni passo di book-keeping della mappa. `/trailhead:quick <n>` fa lo stesso per un ticket che esiste già.

Vedi l'intera whiteboard con `/trailhead:whiteboard`. Niente cambia riguardo alla mappa: ne sei semplicemente sceso, hai fatto la cosa, e ci risali quando sei pronto.

I tre che mandano le persone in confusione sono **idea, seed, todo**, quindi eccoli esplicitati:

- **`idea`** = *forse, e non ancora chiaro.* Atterra nella **fog** (`Not yet specified`), **non** come ticket, perché non puoi nemmeno formulare la domanda in modo nitido ancora, quindi non c'è nulla da lavorare. Si **diploma** in un ticket più tardi, quando la frontier la raggiunge o semplicemente diventa più chiara.
- **`seed`** = *sì, ma non ancora.* È **un** ticket, ma **parcheggiato** (`trailhead:blocked`) su un **trigger** che nomini ("when the public API ships", "when we pass 1k users"). La domanda è già nitida; ciò che manca è una **condizione**, non la chiarezza. Quando il trigger scatta, si diploma sulla frontier.
- **`todo`** = *sì, ora.* Lavoro definito che farai e basta: nasce come **`build` ticket sulla frontier**, prendibile immediatamente.

I due tagli che contano: **idea vs seed** è aspettare la *chiarezza* vs aspettare una *condizione* (entrambi atterrano "dopo", per ragioni diverse); **seed vs todo** è impegnato *dopo* vs impegnato *ora*. Sotto tutti e tre sta **`note`** (testo grezzo da ricordare, forse mai lavoro), e di lato c'è **`bug`** (un difetto, non un livello di impegno). Il test per idea vs ticket è sempre: **puoi formulare la domanda con precisione ora?** Sì → un ticket (`todo` se prendibile, `seed` se gated); no → la fog (`idea`).

---

## 🎫 Tipi di ticket e i loro motori

Ogni ticket porta una label di tipo; ogni tipo ha il proprio modo di essere risolto.

Ogni tipo ha il proprio motore inline: nessuna skill esterna viene invocata.

| Type | Produce | Mode | Engine |
|---|---|---|---|
| 🧭 `decision` | una scelta | HITL | diverge le opzioni se non chiare, poi grill per convergere su una |
| 🔬 `research` | un fatto | AFK | un subagent su un branch usa-e-getta (l'unico tipo eseguito in parallelo) |
| 🎨 `prototype` | una direzione approvata | HITL | un artefatto grezzo usa-e-getta a cui reagire; le schermate UI passano da qui (disco, o un progetto claude.ai/design configurato) prima del codice UI |
| 🔨 `build` | codice funzionante | HITL/AFK | `discuss → plan → execute → verify`: commit atomici, TDD ai seam, **prima un mockup per la UI rivolta all'utente** (tecnica Prototype, gated da `design.approval`), code review + acceptance testing (browser-drive o UAT conversazionale passo-passo) |
| 🐛 `bug` | codice corretto | HITL/AFK | `repro → diagnose → fix → verify`; un difetto in lavoro chiuso è un ticket *nuovo* (`Regression of:`), non una riapertura |
| 🔧 `task` | un cambiamento di stato esterno | HITL/AFK | lavoro manuale che sblocca una decision (provisioning accessi, spostamento dati, iscrizioni) |

Due regole pratiche: i build ticket **non fanno mai auto-grill**: su un'ambiguità bloccante la skill si ferma e chiede; e il brainstorming (divergenza) vive nel charting, nel micro-charting di `ticket`, e nella fase di opzioni di una `decision`, mai nel grilling stesso, che converge soltanto.

---

## 🏷️ Labels

Tutto ciò di cui la mappa ha bisogno è espresso come label GitHub, così lo stato è interrogabile nella UI del tracker:

- **Strutturali:** `trailhead:map`, `trailhead:ticket`
- **Anchor con scope di repo (uno ciascuno per repo, pinnati):** `trailhead:codebase` 🧱 (la codebase map distillata), `trailhead:conventions` 📜 (il modo di lavorare), `trailhead:dashboard` 📊 (l'indice pinnato di mappe + whiteboard + conteggi); ogni titolo porta la sua icona (come il 🗺 della mappa) così gli anchor pinnati si distinguono a colpo d'occhio
- **Type (una per ticket):** 🧭 `trailhead:decision` · 🔬 `research` · 🎨 `prototype` · 🔨 `build` · 🐛 `bug` · 🔧 `task`
- **State:** `trailhead:blocked` (ha un blocker aperto) · `seed` (parcheggiato su un trigger) · `out-of-scope` (chiuso, oltre la destination) · `superseded` (chiuso, splittato in figli)
- **Container:** `trailhead:whiteboard` (un ticket sciolto, senza mappa, fuori dalla frontier di ogni mappa, sulla frontier propria della whiteboard)

La **frontier** è quindi una singola query (aperto, non assegnato, non `trailhead:blocked`), senza bisogno di parsare il corpo.

## 👥 Lavorare in team

Molte persone (e le loro sessioni di agente) condividono una mappa e la lavorano in concorrenza:

- **Claim = assegnare a te stesso.** Chi rivendica possiede il ticket dall'inizio alla fine e lo chiude: non c'è approvatore e nessuno da attendere. Su una collisione di claim la sessione si ferma e chiede a te, invece di risolverla silenziosamente.
- **Split** un ticket sovradimensionato in figli e supersede l'originale (`/trailhead:split`).
- **Pause/resume** tramite un commento di checkpoint `PAUSED`, così qualsiasi sessione può riprendere un ticket.
- **Isola le sessioni concorrenti con i worktree.** Il claiming tiene due sessioni fuori dallo *stesso* ticket, ma due sessioni su ticket *diversi* nello *stesso* clone condividono comunque un working tree. Imposta `isolation: worktree` nell'header delle conventions e ogni ticket in esecuzione gira nel proprio `git worktree` su un branch `trailhead/t<n>`, integrato di nuovo nel trunk al Resolve. Implica un branch per ticket anche sotto `git: main` (git non farà il checkout del trunk due volte), ed è la postura giusta per un **monorepo** (un worktree condivide l'object store, molto più economico di un secondo clone). Un'avvertenza: un worktree isola il *source* ma è un path nuovo senza dipendenze installate, quindi un **package legato a un path** (React Native/Expo, toolchain native, qualsiasi cosa legata a un `node_modules` locale) non buildera da lì. Per questi c'è **`isolation: clone`**: un clone dedicato per-ticket che installa le proprie dipendenze e builda/UATa come l'app vera (più pesante di un worktree, e lo strumento giusto per un submodule Expo/RN). Oppure tieni `isolation: none` e serializza. Altrimenti esegui le sessioni concorrenti in clone separati.
- **Un marker session-ticket per la tua statusline.** Quando inizia a lavorare un ticket, trailhead deposita una riga singola, gitignorata, `.trailhead/session-ticket` (`#<n> <title>`) alla radice di lavoro e la pulisce all'handoff. È puramente un hint economico e offline così una statusline (o qualsiasi tool) può mostrare *su quale ticket è questa sessione* senza colpire il tracker; trailhead stesso continua a trattare le Issue come fonte di verità.
- **Ti dà una spinta quando l'isolation non è mai stata scelta.** Se un repo è stato tracciato o adottato prima che impostassi una modalità `isolation:` (quindi assume silenziosamente `none`), la prima volta che vai a lavorare un ticket con un vero rischio di collisione (un altro ticket in corso, o tooling legato a un path nel suo `Scope:`) trailhead fa emergere un suggerimento di una riga della modalità adatta (`worktree` o `clone`) invece di modificare silenziosamente il checkout condiviso. Qualunque cosa decidi, incluso tenere `none`, scrive la chiave `isolation:` nelle conventions così la scelta è registrata e non chiede mai più. Un header che ha già impostato `isolation:` viene lasciato in pace.
- **Dai scope ai ticket per path su un monorepo.** Un ticket può portare una riga `Scope:` che nomina il/i package/dir che tocca: scope disgiunti parallelizzano in sicurezza, e dà scope a build/test e ai commit del worktree limitandoli al package interessato. `/trailhead:adopt` rileva un monorepo e propone sia `isolation: worktree` sia la convenzione `Scope:`. Sotto `isolation: none`, `Scope:` **serializza** anche un'area condivisa: al momento del claim una sessione si trattiene se lo scope di un altro ticket in corso si sovrappone, così due ticket con scope sullo stesso submodule/package non possono girare insieme (è così che tieni due sessioni fuori da un'app legata a un path).
- **I git submodule sono gestiti come repo separati.** Il lavoro che atterra dentro un submodule viene committato *dentro il submodule* più un bump del gitlink nel parent, e (sotto `worktree`) isolato a livello di submodule, non del superproject. Un ticket che copre due submodule resta atomico tramite un singolo commit del parent che bumpa entrambi i gitlink insieme; il suo `Scope:` li nomina entrambi. `/trailhead:adopt` rileva `.gitmodules` e scrive la regola nelle conventions.
- **Lo stato vive sui ticket** (claim, label, commenti; tutti conflict-free); il corpo della mappa è un indice ri-leggibile, non la fonte di verità. Il record durevole di una risoluzione è il commento del ticket stesso.
- **Le label sono protette dagli esterni.** Le label `trailhead:*` guidano la mappa, quindi trailhead si fida di una issue etichettata solo quando un collaboratore con accesso in scrittura ha applicato la label e (per un ticket) porta un `Parent:` valido. Qualsiasi altra cosa è messa in quarantena come `trailhead:unverified`, fuori dalla frontier. GitHub già blocca gli utenti senza accesso in scrittura dall'applicare label; contro gli utenti di triage e le automazioni, trailhead può **installare per te la GitHub Action di label guard** (da `templates/trailhead-label-guard.yml`) nella `.github/workflows/` del tuo repo, dove rimuove alla fonte le label `trailhead:*` non autorizzate. Installare un workflow richiede un token con lo scope `workflow`, quindi trailhead esegue `gh auth refresh -s workflow` se il push viene rifiutato.
- **Le issue aperte da altri vengono triage-ate, non fidate alla cieca.** `/trailhead:inbox` elenca le issue in ingresso (bug report, richieste, domande che non sono ancora trailhead ticket) e integra quelle valide **sul posto**: riformulandole come ticket, mantenendo l'autorialità di chi ha segnalato, e applicando le label all'adozione. Il resto viene instradato a fog, out-of-scope, duplicato, o needs-info.

## ✅ Tenere i ticket onesti

Un ticket è una singola Question a cui si può rispondere, dimensionata a una sessione, così non lo fai mai crescere in corsa. Quando nuovo scope emerge mentre lavori (i test soprattutto scatenano idee), decidi caso per caso: piccolo e parte della stessa Question → fallo e basta; gonfia il ticket oltre una sessione → **splittalo**; lavoro separato o un follow-up → **catturalo** (`idea`/`todo`/`ticket`/`bug`) e continua. Gli extra non diventano mai righe silenziose dentro il ticket su cui sei.

I ticket che nascono da altro lavoro portano un puntatore di lignaggio nel loro corpo, così la mappa resta tracciabile:

| Pointer | Significato |
|---|---|
| `Split from:` | figlio di un ticket che è stato splittato |
| `Regression of:` | un bug nel lavoro di un ticket chiuso |
| `Surfaced from:` | un'idea/ticket emersa mentre si lavorava un altro ticket |

---

## ⚙️ Configuration

Tre layer: **il più vicino vince**, chiave per chiave (una chiave non impostata a un layer eredita il successivo):

- **Project**: un file `.trailhead/config.json` alla radice del repo: override per questo progetto, committato così un team condivide una config. La config vive in un file semplice, **mai nella issue della mappa**; è tua da cambiare in qualsiasi momento.
- **Global**: `~/.claude/trailhead/config.json`: i tuoi default permanenti su ogni progetto.
- **Defaults**: i valori integrati.

`/trailhead:config` esegue un **setup guidato, a menu**: scegli lo scope, poi percorri ogni impostazione (🌐 ticket language · 🧠 models · 🎨 design + approval · 🧪 TDD · 🖥️ acceptance testing · 🧑‍⚖️ plan review · 📊 statusline) come un menu con icone; niente editing manuale del JSON. Ogni passo è chiesto (nessuno saltato), e i **modelli plan ed execute sono sempre due scelte separate e version-pinned**. `config get` stampa la config effettiva unita; `config set <key> <value>` scrive una chiave.

Il passo **📊 statusline** offre di installare la status bar di trailhead per Claude Code: una riga con **model · project · branch · plan usage (`5h %` · reset · `7d %`) · una barra della context-window**, più una **seconda riga con il ticket attivo** (`▸ #N Title`) ogni volta che ne stai lavorando uno, e un flag `⬆ trailhead <version>` quando è disponibile un trailhead più recente (esegui `/trailhead:update`). Il project è sempre il nome del repo principale anche da un checkout isolato, e il branch porta un tag `(WT)` in un worktree o `(C)` in un clone per-ticket (niente sul checkout originale). È un'impostazione globale di Claude Code; se già usi una statusline (es. `ccstatusline`) il setup chiede prima di rimpiazzarla, e lo script espone anche i segmenti `--ticket-only` / `--context-only` / `--usage-only` da inserire in un tool esistente.

**Offerta al primo uso (una volta per progetto).** Non devi andarla a cercare: la prima volta che configuri un progetto (alla fine di `/trailhead:new`/`:adopt`, o su un `/trailhead` nudo quando esiste una mappa ma non una config) trailhead offre di eseguire il setup guidato, o di continuare sui default. Chiede **solo una volta**: configurare scrive `.trailhead/config.json`, e "continua sui default" scrive un `{}` vuoto. Una volta che quel file esiste non viene più offerto, e non interrompe mai a metà ticket.

| Key | Values (default **bold**) | Effetto |
|---|---|---|
| `ticket.language` | un codice ISO 639-1 (**`en`**) | la lingua in cui trailhead **scrive** la sua prosa GitHub e le descrizioni dei commit, disaccoppiata dalla lingua in cui conversa |
| `models.{plan,execute,research,review,debug}` | un id modello completo **versionato** (**inherit session**) | quale modello esegue ogni attività; `plan` ed `execute` sono sempre impostati separatamente |
| `design` | **`disk`** \| `claude.ai/design` | dove vanno i mockup UI: HTML usa-e-getta locale, o claude.ai/design via l'MCP ufficiale Claude Design di Anthropic |
| `design.surface` | **`canvas`** \| `design-system` | sotto `claude.ai/design`, quale superficie: un progetto canvas (default) o un progetto design-system via `/design-sync` |
| `design.approval` | **`explicit`** \| `auto` | attendi l'approvazione del mockup prima del codice UI, o procedi senza bloccare |
| `tdd` | **`seams`** \| `on` \| `off` | come il motore `build` testa |
| `acceptance.browser` | **`auto`** \| `on` \| `off` | guida il browser in Verify, o ti accompagna in una UAT conversazionale (passo-passo in chat, non una checklist da fare da solo) |
| `testing.webapp` / `testing.url` | bool / URL | è browser-drivabile, e dove |
| `plan_review` | **`off`** \| `on` \| CLI list | invia i PLAN di `build` ad AI CLI esterne (Gemini, Codex, …) per un secondo parere e converge sulle loro obiezioni |
| `plan_review.rounds` | integer (**`2`**) | numero massimo di round converge-and-re-review |

**Models.** Ogni chiave esegue la sua attività come **subagent** sul modello che nomini, così l'intera suddivisione per-attività si applica dentro una singola sessione di lavoro, qualunque modello quella sessione esegua:

- `plan` ed `execute` sono i passi del motore build/bug. Execute è anch'esso un subagent, e committa su `main`.
- `research`, `review`, `debug`, e il fan-out della codebase-map girano ciascuno sulla propria chiave.

Scegli `plan` ed `execute` separatamente, ciascuno per **id completo versionato** (mai un `opus` o `sonnet` nudo). Una chiave non impostata, o uguale al modello della sessione, gira semplicemente inline.

La **sessione principale resta l'orchestratore**. Tiene i momenti interattivi (il Discuss di un build, e l'acceptance/UAT del Verify) e fa charting, grilling e scrittura dei ticket sul proprio modello. Nessuna chiave governa la qualità dei ticket, quindi esegui le sessioni di charting sul tuo modello forte.

Esempio di file di config (la stessa forma funziona per il `.trailhead/config.json` di progetto e il `~/.claude/trailhead/config.json` globale):

```json
{ "ticket": { "language": "en" }, "models": { "plan": "claude-opus-4-8", "execute": "claude-sonnet-5" }, "tdd": "seams", "acceptance": { "browser": "auto" } }
```

**Design mockups.** `design: disk` (il default) deposita un mockup HTML statico usa-e-getta accanto al codice e lo collega dal ticket. `design: claude.ai/design` invece crea il mockup su claude.ai/design via l'**MCP ufficiale Claude Design** di Anthropic (`claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp`, accedi con `/design-login`), dove lo affini visivamente. `design.surface` sceglie quale superficie:

- **`canvas`** (default): un progetto design (canvas) normale, la casa naturale per una schermata singola a cui reagire, modificabile sulla canvas ed esportabile come prototipo live.
- **`design-system`**: un progetto design-system guidato da **DesignSync** (la skill `/design-sync` più l'MCP `claude-design`), per una libreria di componenti condivisa tenuta in sync.

Alla prima schermata UI, trailhead chiede a quale progetto agganciarsi: **sceglierne uno esistente**, **incollare un URL `claude.ai/design/p/<id>`**, oppure **crearne uno nuovo** (ti chiede il nome). Fa il caching dell'id scelto in `design.project`; un progetto già in cache da prima mantiene la superficie `design-system` a meno che tu non imposti `design.surface`, così i setup esistenti non cambiano. Ogni schermata viene aggiunta lì, e la sua URL è collegata dal ticket. Una volta che approvi, trailhead **ri-fetcha** il design corrente (nel caso tu l'abbia modificato live) prima di scrivere qualsiasi codice UI.

Se l'MCP Claude Design completo non è connesso, `canvas` ripiega sul percorso design-system o sul disco locale; su Codex (nessun MCP Claude Design) è sempre disco locale. `design.approval` decide se il build attende il tuo esplicito via libera (`explicit`), o procede subito dopo aver mostrato il mockup (`auto`).

---

## 🪝 Hooks

Oltre alle istruzioni della skill, trailhead include tre hook propri (in `hooks/`, self-contained via `${CLAUDE_PLUGIN_ROOT}`) che *impongono* le parti della disciplina che non ci si dovrebbe fidare che il modello ricordi:

- **Commit guard** (`PreToolUse` su `git commit`): blocca in modo netto un commit il cui subject non è [Conventional Commits](https://www.conventionalcommits.org), e blocca in modo netto qualsiasi trailer `Co-Authored-By`. Questo rispecchia la validazione dei commit di GSD.
- **Secret guard** (`PreToolUse` sulle scritture `gh` di issue/PR): trailhead pubblica molto sul tracker (corpi dei ticket, commenti del motore, issue codebase/conventions, risoluzioni). Questo scansiona ciò che una scrittura `gh issue`/`gh pr`/`gh api` sta per pubblicare (l'inline `--body`, un heredoc, o un `--body-file`) e lo **blocca in modo netto** se corrisponde a un pattern di credenziale (chiavi private, token GitHub/AWS/OpenAI/Slack/Google/Stripe, JWT, o un `password`/`secret`/`token=…` hardcoded). Il blocco è un **segnale di pulisci-e-riprova, non un vicolo cieco**: trailhead redige il valore segnalato sul posto (`<REDACTED>` o un riferimento a env-var) e ripubblica automaticamente, così il contenuto pulito atterra comunque: il segreto semplicemente non raggiunge mai il tracker. Resta un *blocco* fail-safe anziché una silenziosa auto-riscrittura di proposito: un blocco non fa mai leak, mentre una redazione che silenziosamente non è stata applicata sì. Non scansiona mai le letture, solo le scritture in uscita.
- **Issue injection scanner** (`PostToolUse` sulle letture `gh`): trailhead legge testo di issue/PR/commenti scritto da chiunque abbia accesso al repo, cioè input non fidato. Quando quel testo contiene frasi di prompt-injection, l'hook inietta un avviso che ricorda all'agente di trattarlo come dati, mai come comandi. Solo advisory: non blocca mai.

Tutti e tre sono crash-safe (qualsiasi errore → allow) e attivi ogni volta che il plugin è installato. I guard di commit e secret quindi si applicano in **ogni** repo, non solo nei progetti trailhead: intenzionale, dato che i conventional commit, niente `Co-Authored-By`, e nessun segreto leakato sono regole permanenti di trailhead. Per fare opt-out, disabilita gli hook del plugin nelle impostazioni di Claude Code.

---

## 🙏 Acknowledgements

`trailhead` poggia sulle spalle di due corpi di lavoro. È una metodologia originale e self-contained **ispirata da** essi. Non copia né ridistribuisce il loro codice, e non invoca nessuna delle loro skill; reimplementa le idee come propri protocolli inline:

- **[Matt Pocock](https://www.aihero.dev)**: per **Wayfinder**, il cui modello map / frontier / fog-of-war è la spina dorsale della metà di pianificazione di trailhead, e le cui skill `grilling`, `domain-modeling`, `prototype`, `research`, e `tdd` hanno plasmato le tecniche inline di trailhead. Vedi [`mattpocock/skills`](https://github.com/mattpocock/skills).
- **Il team [open-gsd](https://github.com/open-gsd/gsd-core)**: per **GSD**, il cui ciclo `discuss → plan → execute → verify`, il modello di cattura, il codebase mapping, e il debugging sistematico sono il motore della metà di costruzione di trailhead.

Grazie. Se ti piacciono le idee qui, vai a mettere una star e usa gli originali: vanno molto più in profondità dei protocolli compatti di trailhead.

---

## 📄 License

MIT © Marco Migozzi ([@ToRvaLDz](https://github.com/ToRvaLDz))
