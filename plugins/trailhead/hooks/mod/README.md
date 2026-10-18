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
  there is none). During an autonomous run ` · auto 3 done` is appended.
- **Band above the prompt**: row one is the ticket number (bold, accent) and the title cut to
  the band width with `…`; row two is the pipeline `discuss › plan › execute › verify`
  (`✓` done in green, `▸` current in bold accent, pending dim). Step `resolve` shows all four
  done, step `paused` shows all four dim followed by `‖ paused`. During an autonomous run
  `auto · <n> done` sits at the right end of row two.
- **Orphaned**: when the file names another session than the current one (a `/clear`, a
  resume, a new window), the entry gets ` · orphaned, resume?` and the band is drawn dim with
  `orphaned, resume?` after the stages. A `/clear` marks the state on screen as orphaned at
  once, without waiting for a turn: the engine empties the mod's atoms on `/clear`, so the file is
  read again when the new session starts (`classic.SessionStart`, source `clear`). A file with no
  session is never orphaned.
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
them; with no pin the numbers stand alone. The section is absent with no state, with an orphaned one, and under `--bare`.

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

- **What it shows**: the map as a link with its destination (dim), then `Frontier · n`,
  `In progress · n`, `UAT · n`, `Paused · n` and `Blocked · n` (an empty group is left out). A row is `#n title`
  (a link to the issue) and the type, dim. Every assigned row shows its holder as `@login`; the ticket
  in play in this session is marked `▸` in the accent and says `this session` in place of its holder;
  blocked rows are dim. The `ownTicket` atom keeps that mark when another session's work state takes
  over the shared file (a state stamped with another session leaves it; a missing file clears it only
  when the last state read was this session's, i.e. its own Resolve); with no own ticket the work
  state decides, as before. A ticket carrying `trailhead:paused` (set by pause, cleared by resume or a
  `work`/`quick` claim) shows once, under `Paused`, between In progress and Blocked, with a `resume`
  button in place of its holder (it runs like `work`, with `/trailhead:resume <n>`, which checks the
  claim); the label wins over `trailhead:blocked` and an assignee. A
  ticket carrying `trailhead:uat` (a pending UAT follow-up, a marker never a state) shows once, under `UAT`,
  between In progress and Paused, whatever its state (`paused` wins), keeping its `work` button or holder, with a
  dim `tests <parent title> #<n>` line under it. The parent comes from the `UAT of:` line of its body, read once
  per refresh by `gh issue list --label trailhead:uat --label trailhead:map-<n>` (`--label trailhead:whiteboard`
  on the whiteboard view) `--json number,body`, capped like the ticket list at 200: beyond that, or when the read
  fails, a UAT row is drawn without its parent line (the rows still group by label). A
  frontier row has a `work` button that clears the conversation (`/clear`) and then runs
  `/trailhead:work <n>` in the new one (a paused row's `resume` does the same with `/trailhead:resume <n>`), both through `$.command.run`, which the host queues behind a
  running turn; the row shows `queued` until the calls settle (across the reset too), and a
  second press meanwhile is ignored. A press while the session is not in the pinned repo (a shell `cd` moved it, or its
  checkout cannot be read) is refused with a toast before the `/clear`, since the host runs the verb in the
  session's own directory. A refused `/clear`, or one that
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
- **Dashboard view**: the `Whiteboard` row (the header has no button for it) opens the repo index. It draws a `Dashboard` title (a link
  to the pinned `trailhead:dashboard` issue when there is one) with a `map` button that goes back to the map
  shown before (the view is kept), a `Maps · n` group with every open map pressable (a press leaves the
  dashboard and views that map, the active one marked `●`), and a `Whiteboard · <n> open · <m> assigned` section (counted
  over the listed tickets; `200+ open` when the list is capped): the open
  `trailhead:ticket` + `trailhead:whiteboard` tickets as Frontier / In progress / UAT / Paused / Blocked, with the same rows,
  holders and `work` buttons (the work verb takes a whiteboard ticket as is). Unverified ones are counted only.
  Its reads replace the map's in a refresh: the whiteboard list, `gh issue list --label trailhead:dashboard
  --json number,url` and the maps list; a failed list keeps the last one with the footer reason, a failed index
  read alone keeps the last link. Data in the `dashboardPane` atom; the mode survives `/clear` like the view.
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
  `gh issue list --label trailhead:map-<map> --state open` (plus the history read under "Burn-down" and the maps list read) through `$.process.run`,
  where `<map>` is the viewed map, else the active one. A result is dropped if the pane closed or the shown map changed while `gh` ran.
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
  `session.start`, `turn.complete`, a Bash call that runs `gh issue edit|close|create|comment|reopen`,
  the `refresh` button, and a slow timer started on open. Never two fetches inside `MIN_REFRESH_MS`:
  a request inside the floor keeps one trailing refresh for the rest of it.
- **Auto-open**: once, in fullscreen (`e.viewport.isFullscreen === true` in the `AbovePrompt` render),
  when a map is active. Never on the main screen, never again after the pane was opened or closed
  by the person (a press on the `close` button counts as closing it). The open runs from a zero-delay timer because a render may not write state.
- **Constants** (`map-pane.tsx`): `PANE_ID = 'trailhead-map'`, `PANE_TITLE = 'Map'`,
  `MIN_REFRESH_MS = 15_000`, `TIMER_MS = 180_000`, `GH_TIMEOUT_MS = 20_000`,
  `PANEL_COMMAND = 'trailhead:panel'`, `MAPS_LIMIT = 100` (not exported); `map-pane-view.ts`: `LIST_LIMIT = 200`, `HISTORY_LIMIT = 5000`.
- **Atoms**: `mapPane` (with `maps`, the open maps), `activeMap`, `viewedMap` (`null` follows the active map), `isDashboard`, `dashboardPane`, `pendingWork`, `paneAutoOpened`. Module variables hold the queue and
  the timers, what `/clear` carries over (`carried`) and the `work` press in flight (`workInFlight`),
  because `/clear` empties the atoms while they are needed.
- **Validator note**: `claude plugin validate` follows `$` only inside one file and refuses two
  hooks on one event with no matcher. So `map-pane.tsx` registers `session.start`, `turn.complete`
  and `tool.call` with matchers that always hold (or narrow: the `gh issue` write), next to the
  bare hooks of `register.tsx`.

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
