# trailhead mod (contributor note)

`register.tsx` is the trailhead mod: a TypeScript hooks module that Claude Code loads
next to the command hooks. It shows the ticket in play, read from `.trailhead/work-state.json`
(written by the skills through `templates/trailhead-work-state.js`; the mod only reads it).
The engine writes it in the ticket's own workspace, so when the pinned checkout has none the mod looks in the
repo's other checkouts (also when the pinned one holds another session's state; `git worktree list`, sibling `<repo>-t<n>` clones) and adopts the one naming this session
(`work-state-locate.ts`). After a `/clear` a state in another checkout is not shown (it names the old session),
unlike the own checkout's orphaned display.
The typed contract lives in `plugins/trailhead/types/index.d.ts`, wired through the
`types` key of `plugin.json`. The module is declared in `hooks/hooks.json` under
`"modules"` (exactly one path, relative to `hooks.json`). The pure parts (parsing the file,
the status text, the pipeline stages) are in `work-state-view.ts`. The map pane lives in
`map-pane.tsx` (hooks and drawing) and `map-pane-view.ts` (pure parts); see "Map panel" below.

## What it shows

- **Status entry**: one line under the prompt, `map #198 · #203 Title · plan` (the engine prefixes it with the plugin name, `trailhead:`)
  (`whiteboard` instead of `map #<n>` for a ticket with no map; the title is left out when
  there is none). During an autonomous run ` · auto 3 done · 2 in flight` is appended (see
  [Autonomous run](#autonomous-run)).
- **Band above the prompt**: row one is the ticket number (bold, accent) and the title cut to
  the band width with `…`; row two is the pipeline `discuss › plan › execute › verify`
  (`✓` done in green, `▸` current in bold accent, pending dim). Step `resolve` shows all four
  done, step `paused` shows all four dim followed by `‖ paused`. During an autonomous run
  `auto · <n> done · <m> in flight` sits at the right end of row two.
- **Another session / orphaned**: when the file names another session than the current one (a
  resume, a new window, a parallel session), the ticket is not this session's, so it is not in
  play and not in the system prompt. By default it reads neutrally: the entry gets
  ` · in another session` and the band keeps its normal look with `in another session` after
  the stages, no resume hint. It reads ` · orphaned, resume?` (band drawn dim with
  `orphaned, resume?` after the stages) only when the Claude Code session registry confirms the
  session is gone: the registry is `<config dir>/sessions/<pid>.json` (`sessionId`, `pid`; the
  config dir is `$CLAUDE_CONFIG_DIR`, else `~/.claude`), and a session is gone when no entry names
  its id with a live pid. The pid is checked through `/proc` where it exists (Linux); elsewhere the
  entry's presence counts as alive. A registry that cannot be listed or read, has unparseable
  files, or is empty falls back to the neutral wording, never orphaned. A `/clear` marks the state
  on screen as orphaned at once, without the registry and without waiting for a turn: the engine
  empties the mod's atoms on `/clear`, so the file is read again when the new session starts
  (`classic.SessionStart`, source `clear`). A file with no session is never orphaned.
- **Quiet**: with no file, or a file that cannot be parsed (no valid ticket and step), the
  band draws nothing and the status entry is cleared. A survey holding the band makes the
  band yield, and the status entry stays. A read error other than "missing file" keeps what
  is on screen.

The file is read on `session.start`, `turn.start`, `turn.complete`, and after a Bash call whose
command contains `trailhead-work-state.js` (so a step change shows without waiting for a turn).
Atoms and the status entry are only written when their content changed.

## System prompt

Next to the screen pieces, the mod appends one section, `trailhead:work-state`, to the system
prompt through `prompt.compose` (session side of the cache boundary, after the engine's own
sections). It names the active map, the ticket in play (number, title, link) and the step, so the
agent keeps its bearings after a compaction. Links follow the pinned repo (its host included, see "Which repo"), so a shell `cd` out of it keeps
them; with no pin the numbers stand alone. The section is absent with no state, with a foreign one (orphaned or in another session), and under `--bare`.

It is a latched snapshot kept in the `promptSnapshot` atom (session scoped): what the model has
been told. It is reset at `session.start`, after a main-loop compaction (`session.compact`, once it
did not skip) and on `/clear`; only the first persisting compose after a reset writes it. A later
compose never rebuilds it: it returns the latched text, so the system prompt stays what the engine
already holds (the engine composes every turn but keeps sending the first one). Only `prompt.submit`
advances the latch after that, when the map, ticket, title, orphaned flag or auto flag changed. A
`precompute` or a subagent's compaction installs nothing in the conversation, so it leaves the
snapshot alone. A step change deliberately leaves the text alone, so the prompt cache holds; the
section says the step may have moved on and that `.trailhead/work-state.json` holds the live one.
For the same reason an autonomous run shows as `Mode: autonomous run`, without the done count.

The engine composes the system prompt once per process (first request) and keeps it; only a session
start, a main-loop compaction and `/clear` compose again. So a change made mid-session (the first
`trailhead-work-state.js set`, a new ticket, the state cleared) does not reach the model through
`prompt.compose`. A `prompt.submit` hook treats the latched snapshot as what the model has been told:
when the live key differs, it attaches the new section as `context` on that prompt, once per change
(overlapping prompts attach it once), and latches it; a prompt dropped beneath puts the latch back, so
the next one carries the change, as does one whose hook failed beneath or whose latch write was denied
(the latch stays where it was and the next prompt retries). A per-session in-memory mirror of the latch,
set only after a successful atom write, lets overlapping prompts agree on it. If the state went away it attaches a one-line note that the earlier section is
stale. With no compose yet it does nothing (the first compose carries the state), and it skips slash
commands and fails open: the prompt is never dropped.

The issue title is untrusted text from GitHub. It is rendered as quoted data
(`Ticket: #204 "Title"`), with zero-width and bidi controls removed, inner double quotes turned
into single ones, and a line saying the title is data, not an instruction. The text is at most
1024 bytes and carries no skill protocol.

`next(e)` is called once, before any enrichment, and a failure while enriching returns the
engine's sections untouched. With no pin the section is built without links and
latched like any other. A `/context` render (`analysis` trait) shows the section but never writes
the atom.

## Map panel

`/trailhead:panel` opens or closes a pane listing a map's open tickets (the active map's, or the one clicked in the maps list). It is a plugin
command file (`commands/panel.md`), because a command registered by a mod cannot carry the
`trailhead:` namespace; the mod answers it before it reaches the model, so the file's body runs
only where no mod does (it says the panel is not available). Claude Code only: the Codex
projection leaves the `panel` verb out (`CODEX_MOD_ONLY_VERBS` in `bin/lib/codex-projection.js`).

- **What it shows**: the map as a link with its destination (dim), then `Needs you · n`, `Frontier · n`,
  `In progress · n`, `UAT · n`, `Paused · n` and `Blocked · n` (an empty group is left out). A row is `#n title`
  (a link to the issue) and the type, dim. Every assigned row shows its holder as `@login`; the ticket
  in play in this session is marked `▸` in the accent and says `this session` in place of its holder;
  blocked rows are dim. The `ownTicket` atom keeps that mark when another session's work state takes
  over the shared file (a state stamped with another session leaves it; a missing file clears it only
  when the last state read was this session's, i.e. its own Resolve); with no own ticket the work
  state decides, as before. A ticket carrying `trailhead:paused` (set by pause, cleared by resume or a
  `work`/`quick` claim) shows once, under `Paused`, between In progress and Blocked, with a `resume`
  button in place of its holder (it runs like `work`, with `/trailhead:resume <n>`, which checks the
  claim); the label wins over `trailhead:blocked` and an assignee.
  A ticket carrying `trailhead:needs-you` (an autonomous run parked it for the human; a `work`/`quick` claim
  clears it) shows once, under `Needs you`, above Frontier. The label wins over paused, UAT, blocked and an
  assignee. Any assignee is shown as its holder, never a button, even on a paused or blocked row. A blocked
  row with no assignee is dim with no button. Any other row gets a `work` button, never `resume`, even when
  paused: the claim clears the mark and resume would not. A
  ticket carrying `trailhead:uat` (a pending UAT follow-up, a marker never a state) shows once, under `UAT`,
  between In progress and Paused, whatever its state (`paused` and `needs-you` win), keeping its `work` button or holder, with a
  dim `tests <parent title> #<n>` line under it. The parent comes from the `UAT of:` line of its body, read once
  per refresh by a paged `gh api graphql` read of `repository.issues(states: OPEN, labels: ["trailhead:uat"])` (100 a page,
  up to 10 pages), filtered here to `trailhead:map-<n>` (`trailhead:whiteboard` on the whiteboard view). When a page fails
  or is unreadable, or pages are left at the cap, a UAT row is drawn without its parent line (the rows still group by
  label); never a partial map, no search fallback. A
  frontier row has a `work` button that clears the conversation (`/clear`) and then runs
  `/trailhead:work <n>` in the new one (a paused row's `resume` does the same with `/trailhead:resume <n>`), both through `$.command.run`.
  A press during a running turn is held by the panel, which sends nothing to the host: the row shows `queued` with a
  `cancel` button, and the press runs (`/clear`, then the verb) when the turn ends, an interrupted one included.
  `cancel` drops it before anything is sent, so the conversation is untouched and the row goes back to its button.
  With no turn running the press starts at once and the row reads `starting` (no cancel) until the calls settle,
  across the reset too. One press at a time: another while one is held or starting is ignored. A session that ends
  while a press is held drops it. A press while the session is not in the pinned repo (a shell `cd` moved it) still
  starts: the mod cannot move the session, so it appends the pinned checkout to the verb's args as `--in=<token>`
  (base64url of the root) and the verb `cd`s there first. With no repo pinned, or a checkout that cannot be read
  (a removed worktree included), the press is refused with a toast before the `/clear`; both are checked again when
  a held press is sent. A refused `/clear`, or one that
  did not change the session, runs no work command. `trailhead:unverified` tickets are never listed,
  only counted in one dim line; `trailhead:whiteboard` tickets are dropped. The footer is a `refresh`
  button and `updated <age>`, or `⚠ <reason> · list from <age>` after a `gh` failure (the last good list is kept;
  reasons: `gh not installed`, `gh not authenticated (run gh auth login)`,
  `offline: cannot reach GitHub`, `gh failed (exit <n>)`), and a `close` button at the right edge that
  closes the panel. A status too long for the room beside the buttons moves to a row of its own under them. Titles come from GitHub and are untrusted:
  flattened, stripped of control, zero-width and bidi characters, only drawn. Other states: `Loading tickets…`
  on the first fetch, `No active map. Run /trailhead:map to pick one.`, `No open tickets. Fog may remain: /trailhead:map`.
- **Maps list and viewing**: with more than one open map (one `gh api graphql` call for the open
  `trailhead:map` issues with their sub-issue counts, bounded at 100 maps, no pagination),
  a `Maps · n` group sits under the header: one row per map, sorted by number, `#n title` cut to the width.
  Each row ends with a dim `<open> open / <total>` count; if the call fails or is unreadable the pane falls
  back to `gh issue list --label trailhead:map --state open` and draws the names only.
  The active map has `●` in the accent and an `active` aside (after the counts, `7 open / 23 · active`); the viewed map is bold; every other row is a
  `Button`. A press shows that map's tickets, burn-down and `work` buttons (browse); it never writes
  `.trailhead/active-map`. Pressing the active map's row, or `back to active` (in the dim line
  `viewing #n · active #m` shown while another map is viewed), goes back. A `work` press on a viewed
  map's ticket runs `/trailhead:work <n>` as always: the work verb makes the ticket's map the active one
  (its `trailhead:map-<n>` label), and at the next `turn.complete` the pane sees the active map change
  and follows (the view resets to the active map). The view also resets when the viewed map leaves a
  freshly read open list (it closed). A single open map shows no group, as before. With no active
  map the message stays and the open maps are listed under it, so one can be viewed (`viewing #n` then has a
  `back` button). The maps read is the 4th of a refresh; a failure of it alone keeps the last list and sets no
  footer error. Each refresh captures its target (viewed, else active) once and rechecks it before every state
  write, so a refresh in flight when the view changes never commits the old map's tickets.
- **Whiteboard row**: above the Maps list (in the map view, its loading state and the no-active-map view,
  even with a single map) a `Whiteboard` button switches the pane to the repo index, the `isDashboard` atom.
  Beside the name it carries the whiteboard's counts in a map row's shape, dim: `<open> open / <total>`
  (open whiteboard tickets over all of them). They come from the maps read's single GraphQL call (two
  aliased `totalCount` connections on `trailhead:whiteboard`), never a per-ticket query. If that call
  fails or its whiteboard fields are unreadable the row is drawn name-only, no counts and no error (the
  `whiteboard` field of the `mapPane` atom is `null`; a failed read never keeps stale counts).
- **Total line**: one dim line, `<N> open across all maps + whiteboard`, directly under the `Whiteboard` row (in the map
  view, its loading state and the no-active-map view) and under the header row in the Dashboard view. It is the sum of the
  open issues labelled `trailhead:map-<n>` for every open map plus the open issues labelled `trailhead:whiteboard`: the
  dashboard's own count scopes. Both labels are only ever applied to `trailhead:ticket` issues and a ticket carries one of
  them, never both, so the label scopes are the ticket count and nothing is counted twice; closed maps never count,
  whiteboard tickets always do. The source is one extra `gh api graphql` call after the maps read, with one aliased
  `totalCount`-only connection per open map (at most `MAPS_LIMIT` = 100) plus one for the whiteboard, so it is exact and
  has no list limit; the cost is up to one connection per enumerated map per refresh, only while the pane is open (15 s
  floor). The result is the `openTotal` field of the `mapPane` atom, with the map numbers it was computed over. It is
  hidden while unknown: before a first good count, when the count read fails or is unreadable and the open maps are not
  the set the last good total covered (a failed read keeps the last total only over exactly the same maps, beside the
  pane's own failure note), and whenever the maps read fell back to the name-only `gh issue list` (the count query runs
  only on the GraphQL maps path), including when that fallback fails too and the last maps list is kept: with no maps
  read there is no set to check the last total against, so it is hidden until the next good read. When more open maps exist than the maps read returned (`totalCount` above the nodes
  read, so exactly 100 maps is not a cut) the total is a lower bound and reads `at least <N> open across all maps +
  whiteboard`. In a narrow pane it shortens to `<N> open in total` (`≥<N> open in total` for a lower bound), and is left
  out when even that does not fit.
- **Dashboard view**: the `Whiteboard` row (the header has no button for it) opens the repo index. It draws a `Dashboard` title (a link
  to the pinned `trailhead:dashboard` issue when there is one) with a `map` button that goes back to the map
  shown before (the view is kept), a `Maps · n` group with every open map pressable (a press leaves the
  dashboard and views that map, the active one marked `●`), and a `Whiteboard · <n> open · <m> assigned` section (counted
  over the listed tickets; `200+ open` when the list is capped): the open
  `trailhead:ticket` + `trailhead:whiteboard` tickets as Needs you / Frontier / In progress / UAT / Paused / Blocked, with the same rows,
  holders and `work` buttons (the work verb takes a whiteboard ticket as is). Unverified ones are counted only.
  Its reads replace the map's in a refresh: the whiteboard list (the GraphQL open read above), `gh issue list --label trailhead:dashboard
  --json number,url` and the maps list; a failed list keeps the last one with the footer reason, a failed index
  read alone keeps the last link. Data in the `dashboardPane` atom; the mode survives `/clear` like the view.
- **Following the whiteboard**: when this session takes a whiteboard ticket (its own work state names a ticket with no
  map), the panel switches to the Dashboard view by itself, once per ticket. It looks at session start, at the end of a
  turn and after a call to the work-state helper, always after the work state was re-read. Going back to the map by hand
  is not undone (the followed ticket is remembered in a module variable, so a `/clear` does not forget it); a different
  whiteboard ticket later is followed again. After a Resolve the panel stays on the whiteboard. A whiteboard ticket
  created while a map is shown (`gh issue create` with the `trailhead:whiteboard` label) raises a toast,
  `new whiteboard ticket #<n>: open Whiteboard`, instead of switching. The rules are pure, in `whiteboard-follow.ts`.
- **Burn-down**: below the groups, a `Burn-down` section shows the shown map's open-ticket count
  over time, from its first ticket to now. A dim line gives `open <o> · done <d> · removed <r> · peak <p>`
  (`removed` = closed with `trailhead:superseded` or `trailhead:out-of-scope`; `done` = other closed
  tickets). The chart has one sample per pane column. On the terminal surface it is a `Raster` (3 rows
  of eighth blocks, accent colour, key `burndown`); elsewhere a one-row text sparkline (`▁`..`█`).
  The axis line has the start on the left (`Sep 18`, or `today 09:05` under a day, in UTC) and
  `now` on the right, but `now` only while the history is fresh: when the history read failed alone, or
  the whole refresh failed, the last curve is kept, drawn up to the time it was read, and the right label
  shows its age (`3m ago`). The section is hidden with no active map, while loading, or when the history
  is empty or has not been read yet.
  - **Data**: no new storage. One more `gh issue list --label trailhead:map-<map> --state all
    --limit 5000 --json number,labels,createdAt,closedAt`, run with the other two reads in the same
    refresh (same timeout, same drop when the pane closed or the map changed). `trailhead:unverified`
    and `trailhead:whiteboard` rows are skipped.
  - **Failure**: a failed map or open-list read keeps the whole last good data, chart included. A
    failed or unreadable history read alone keeps the last good history only when it belongs to the
    same map (after a map switch no chart is drawn), still accepts the fresh list, and draws the
    axis end as `<age> ago` instead of `now`. The footer stays about the list.
  - **Cap**: `gh` returns the newest tickets first, so a history that reaches `HISTORY_LIMIT`
    misses the oldest; the section then adds `history capped at 5000: starts at the oldest ticket read`.
- **Through `/clear`**: the engine empties the mod's atoms. At `session.end` with reason `clear` the pane
  notes the auto-open flag, the viewed map and the active map; at `classic.SessionStart` (source `clear`)
  it puts the flag back (a pane the person closed is not opened again), reads the active map, puts the
  view back only when the active map is still the one it was set against, and refreshes at once, past
  the floor. The pane is filled again with no turn.
- **Links**: the map and the rows are `Link`s, clickable where the terminal takes OSC 8 links. A
  terminal Claude Code cannot identify (for example `TERM=xterm-256color` with no `TERM_PROGRAM`)
  gets the engine's fallback instead: the text, then the URL in dim on the next line, nothing to
  click. Start Claude Code with `FORCE_HYPERLINK=1` there to get real links.
- **Where the data comes from**: `.trailhead/active-map` (read locally on `session.start` and
  `turn.complete`, whether or not the pane is open), then `gh issue view <map>` and
  the open list of `trailhead:map-<map>` (plus the history read under "Burn-down", the UAT parents and the maps list read)
  through `$.process.run`, where `<map>` is the viewed map, else the active one. A result is dropped if the pane closed or the shown map changed while `gh` ran.
  The open list (a map's, and the whiteboard's) is a `gh api graphql` read of `repository.issues(states: OPEN, labels: [...])`,
  paged 100 a page up to 200 rows, because `gh issue list --label` goes through the search API, which lags a write by seconds:
  a ticket just created or closed would show stale. GraphQL `labels` is any-of, so the whiteboard read filters
  `trailhead:ticket` itself. A page that fails or is unreadable discards the whole GraphQL read (never a partial list)
  and `gh issue list --label <label> --state open` runs once instead. The UAT-parent read joins the open list on
  GraphQL (above), with no search fallback. Only the history (`--state all`) stays on `gh issue list` (search-backed): it can
  trail a write by seconds, which the follow-up read below covers.
- **Which repo**: the one the session started in, pinned (`repo-pin.ts`) when `$.session.repo()` has a
  remote of the form host/owner/name (github.com or an Enterprise host, any ssh/https form). The pinned root
  is the checkout's own toplevel (`git rev-parse --show-toplevel` in the session's project root), so a
  worktree session uses its worktree. It is checked again on each refresh and `turn.complete`. Every `gh`
  call runs with the pinned root as `cwd` (`gh` resolves the host and the `{owner}`/`{repo}` placeholders
  from it), and `.trailhead/active-map` and `.trailhead/work-state.json` are read by absolute path under
  it, so a shell `cd` out of the repo changes nothing. A check outside any repo, or in one with no usable
  remote, keeps the pin; a move into another repo moves it, drops the reads in flight and empties what the
  pane held for the old one. With nothing ever pinned the pane says
  `Not in a GitHub repository: open the session in a trailhead repo` and makes no `gh` call.
- **When it refreshes**: only while the pane is open (a closed pane costs no `gh` call). Opening it,
  `session.start`, `turn.complete`, a Bash call that writes to the tracker, the `refresh` button, and a slow
  timer started on open. A write is `gh issue edit|close|create|comment|reopen|delete|transfer`, a `gh api` call on a
  `repos/.../issues` path with a write method (`-X`/`--method` POST, PATCH, PUT, DELETE) or an implicit POST
  (`-f`, `-F`, `--field`, `--raw-field`, `--input`) and no `-X GET`, or the `trailhead-issue-body.js` helper
  (`GH_ISSUE_WRITE`); reads never refresh. Never two fetches inside `MIN_REFRESH_MS`: a request inside the floor
  keeps one trailing refresh for the rest of it. A write that reads at once also arms that trailing refresh, so one
  more read follows when the floor ends, after the search index (the history) caught up; a burst of writes still costs one
  read per floor plus one trailing. The host drops a refused timer without a word (a refused `every` period ends
  the interval), so the slow timer is kept with its due time: past it by more than `TIMER_GRACE_MS` it is held dead
  and the next trigger starts it again (`isTimerLate`). The trailing refresh is kept with its due time the same way:
  a dropped one is replaced by the next trigger, and a render past its due time by more than `TIMER_GRACE_MS` asks
  for the read at once. A turn end that follows a tracker write newer than the last read start reads at once,
  floor or not (one extra read per turn at most, never without a write), so the final state shows with no timer
  involved; it leaves an armed trailing refresh alone, so the read after the search index caught up still follows.
  A read asked while the pane is undrawn is dropped; a render
  whose list (with no error) is older than `TIMER_MS + TIMER_GRACE_MS` asks for a read at once, as an empty view does.
- **Auto-open**: once, in fullscreen (`e.viewport.isFullscreen === true` in the `AbovePrompt` render),
  when a map is active. Never on the main screen, never again after the pane was opened or closed
  by the person (a press on the `close` button counts as closing it). The open runs from a zero-delay timer because a render may not write state.
  Being unasked, it waits undrawn below 144 columns (`isPlaced: false`), typical of a fresh session; `/trailhead:panel`
  then opens it again as the person's request (drawn at any width) instead of closing it, and closes it only when even
  that leaves it undrawn (no surface places panes).
- **Constants** (`map-pane.tsx`): `PANE_ID = 'trailhead-map'`, `PANE_TITLE = 'Map'`,
  `MIN_REFRESH_MS = 15_000`, `TIMER_MS = 180_000`, `GH_TIMEOUT_MS = 20_000`, `TIMER_GRACE_MS = 30_000`,
  `PANEL_COMMAND = 'trailhead:panel'`, `MAPS_LIMIT = MAPS_READ_LIMIT = 100` (`MAPS_LIMIT` not exported); `worktree-porcelain.ts`: `MAX_FAILURES = 3` (shared by the work-state lookup and the run scan); `auto-run-view.ts`: `RESUME_HINT`; `map-pane-view.ts`: `MAPS_READ_LIMIT = 100`, `LIST_LIMIT = 200`, `HISTORY_LIMIT = 5000`.
- **Atoms**: `mapPane` (with `maps`, the open maps), `activeMap`, `viewedMap` (`null` follows the active map), `isDashboard`, `dashboardPane`, `pendingWork`, `pendingPhase` (`queued` or `starting`), `paneAutoOpened`. Module variables hold the queue and
  the timers, what `/clear` carries over (`carried`), the held press (`held`) and the one being sent (`inFlight`),
  because `/clear` empties the atoms while they are needed. Whether a main turn runs is `turn-state.ts`, kept by
  `register.tsx`'s bare `turn.start`, `turn.complete` and `session.end` hooks and read by the pane.
- **Validator note**: `claude plugin validate` follows `$` only inside one file and refuses two
  hooks on one event with no matcher. So `map-pane.tsx` registers `session.start`, `turn.complete`,
  `session.end` and `tool.call` with matchers that always hold (or narrow: the tracker write), next to the
  bare hooks of `register.tsx`.

## Autonomous run

The mod only watches an autonomous run (`/trailhead:auto`): no Stop hook, no `$.prompt.submit`
that drives, no write to a work state or to the tracker.

- **Run membership.** The run's main checkout is `$.session.repo().root` (the main working tree,
  whatever linked worktree the session sits in); only when that is unreadable the pinned root
  stands in. A checkout's work state belongs to the run when it says `auto: true` and the checkout is
  (a) the main checkout or the pinned one, (b) a `git worktree` of the repo on branch
  `trailhead/t<n>` whose state is for ticket `<n>`, or (c) a sibling directory `<repo>-t<n>` that is an
  independent checkout (its git dir inside it) on `trailhead/t<n>`, with a state for ticket `<n>`. The
  session in the state is ignored: slot states are sessionless on purpose. A symlinked alias of one
  checkout is not recognised as the same path (the mod has no realpath).
- **Scan gate.** The scan runs only when a run can exist: `<main>/.trailhead/auto-run.json` is
  present, or the own work state says `auto: true`. Otherwise the run is cleared at once and no process
  runs, so a session outside a run costs one file read.
- **Label.** `auto · 3 done · 2 in flight · 1 needs you · 1 paused`: `done` is the highest
  `autoDone` among the members, `in flight` counts the members whose step is not `paused`; zero
  counts are left out. With a work state of its own the label sits at the right end of band row two and
  after the step in the status; without one (the slots' states are sessionless) it is a one-line band and
  the whole status.
- **Counts.** `needs you` and `paused` come from one GraphQL `gh api graphql` read with two searches
  (open `trailhead:ticket` issues labelled `trailhead:needs-you` or `trailhead:paused`), narrowed by the
  run record's scope (`map:<n>` to `trailhead:map-<n>`, `whiteboard` to `trailhead:whiteboard`,
  `everything` or an unreadable record to the whole repo). They are scope counts, not run-only counts:
  `paused` is not narrowed to the run's own tickets, and an earlier needs-you mark stays until the
  person clears it. The read runs under the pinned root, only while a run is detected, never
  faster than `MIN_REFRESH_MS`, and on the pin's own host (`--hostname`, so an Enterprise pin is searched there);
  a failed read keeps the last counts; no pin, or no engine clock, means no call.
- **Bounded failures.** A scan that fails (the git listing, a read other than a missing file) keeps
  the last run for at most `MAX_FAILURES = 3` failures in a row, then clears it; a success resets the count.
  Failures are counted at most once per `MIN_REFRESH_MS` (a turn refreshes several times), so a brief git
  hiccup never clears a live run; without a clock every failure counts.
  A clean scan with no member clears the run at once.
- **Resume hint.** `auto interrupted · /trailhead:auto to resume` (in the status
  `auto interrupted, /trailhead:auto to resume`) shows while a flag is set and a run member remains. The
  flag is set by a main-loop `turn.complete` with `isAborted` (an Esc), and by an accepted main-conversation
  compaction that lands while no main turn is running. A compaction inside a running turn sets nothing; if
  that turn then ends aborted, the first rule applies. Subagent turns never touch it. It clears at the
  next main-loop `turn.start` (a background slot's completion starts a new turn), when `/trailhead:auto`
  is submitted and not dropped, and it is hidden once no member is left (hand-back).
- **State.** Atoms `autoRun`, `runCounts`, `autoInterrupted`; the module variables are the last run, the
  failure count, the counts cache and the running-turn flag. The status is recomputed last in each
  refresh, from all of them at once.

## Requirements

- Claude Code 2.1.287 or newer (tested on 2.1.296).
- Command hooks stay the floor. A build without mod support skips only this module;
  every command hook keeps working.
- npm delivery is not done yet: `bin/trailhead.js` does not ship the mod, and the
  Codex projection never sees it. Only the plugin (`--plugin-dir`, marketplace) loads it.

## Dev loop

Run from the repo root.

- Hot reload: `claude --plugin-dir plugins/trailhead` (or set `CLAUDE_CODE_PLUGIN_DIRS`) in an
  interactive session. Saving `register.tsx` reloads the module.
- Validate the manifest, types and module: `claude plugin validate plugins/trailhead`.
  It lists the hooked events and the declared state.
- Run the mod tests (every `*.test.ts` under the plugin): `claude plugin test plugins/trailhead`.
  Tests live in `plugins/trailhead/tests/`. The test `on` hooks stand for the engine: they answer
  `fs.read`, `session.id` and `ui.status`, and the UI tests mount the band and the pane on `terminal` and `desktop`.
  The map pane tests also answer `process.run` (the `gh` runs), `ui.open`, `ui.close`, `ui.panes`, `command.run`
  and `tool.call`, and use `mock.clock` for the floor and the timers. The test `$` cannot raise `ui.open`, so a test
  that has the person open the pane sets the engine's pane list directly.
  A hook result is `{ value }` or `{ deny }`; a `$.fs.read` that must fail is a `{ deny: 'ENOENT: ...' }`.
  A `Text` carries no `key`, so the module keys a `Box` around each one and tests read the Text inside it.
- Everything at once: `npm test`. It runs the `*.test.js` suites, then validate and test.
  Without `claude` on PATH it fails; set `TRAILHEAD_SKIP_MOD_CHECKS=1` to skip the mod checks.
- Debugging: `claude --debug`, or `claude -p --plugin-dir plugins/trailhead --debug-file <file> "say ok"`.
  A healthy load logs `hooks module trailhead@inline loaded (...); events: session.start,classic.SessionStart,turn.complete,tool.call,command.run,ui.render,ui.close,prompt.compose,prompt.submit,session.compact,turn.start,session.end`.
  A module that fails to parse shows `hooks module did not load`.

## Optional type check

An interactive `--plugin-dir` load writes `.claude-plugin/types/` and an engine
`tsconfig.json` into the plugin (both are git-ignored). After that:

    npx -p typescript@5.9.3 tsc -p plugins/trailhead
