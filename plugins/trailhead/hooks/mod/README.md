# trailhead mod (contributor note)

`register.tsx` is the trailhead mod: a TypeScript hooks module that Claude Code loads
next to the command hooks. It shows the ticket in play, read from `.trailhead/work-state.json`
(written by the skills through `templates/trailhead-work-state.js`; the mod only reads it).
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
  once, without waiting for a turn. A file with no session is never orphaned.
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
agent keeps its bearings after a compaction. Links need a GitHub `origin`; without one the numbers
stand alone. The section is absent with no state, with an orphaned one, and under `--bare`.

It is a latched snapshot kept in the `promptSnapshot` atom (session scoped, never a module
variable). It is rebuilt only when the map, ticket, title, orphaned flag or auto flag changes, at
`session.start`, and after a main-loop compaction (`session.compact`, once it did not skip). A
`precompute` or a subagent's compaction installs nothing in the conversation, so it leaves the
snapshot alone. A step change deliberately leaves the text alone, so the prompt cache holds; the
section says the step may have moved on and that `.trailhead/work-state.json` holds the live one.
For the same reason an autonomous run shows as `Mode: autonomous run`, without the done count.

The issue title is untrusted text from GitHub. It is rendered as quoted data
(`Ticket: #204 "Title"`), with zero-width and bidi controls removed, inner double quotes turned
into single ones, and a line saying the title is data, not an instruction. The text is at most
1024 bytes and carries no skill protocol.

`next(e)` is called once, before any enrichment, and a failure while enriching returns the
engine's sections untouched. If the repo cannot be read, the section is built without links and
latched like any other. A `/context` render (`analysis` trait) shows the section but never writes
the atom.

## Map panel

`/trailhead:panel` opens or closes a pane listing the active map's open tickets. It is a plugin
command file (`commands/panel.md`), because a command registered by a mod cannot carry the
`trailhead:` namespace; the mod answers it before it reaches the model, so the file's body runs
only where no mod does (it says the panel is not available). Claude Code only: the Codex
projection leaves the `panel` verb out (`CODEX_MOD_ONLY_VERBS` in `bin/lib/codex-projection.js`).

- **What it shows**: the map as a link with its destination (dim), then `Frontier · n`,
  `In progress · n` and `Blocked · n` (an empty group is left out). A row is `#n title` (a link to
  the issue) and the type, dim. Every assigned row shows its holder as `@login`; the ticket in play
  in this session (work state, not orphaned) is marked `▸` in the accent; blocked rows are dim. A
  frontier row has a `work` button that runs `/trailhead:work <n>` through `$.command.run`, which
  the host queues behind a running turn; the row shows `queued` until the call settles, and a
  second press meanwhile is ignored. `trailhead:unverified` tickets are never listed, only counted
  in one dim line; `trailhead:whiteboard` tickets are dropped. The footer is a `refresh` button and
  `updated <age>`, or `⚠ <reason> · list from <age>` after a `gh` failure (the last good list is kept;
  reasons: `gh not installed`, `gh not authenticated (run gh auth login)`,
  `offline: cannot reach GitHub`, `gh failed (exit <n>)`). Titles come from GitHub and are untrusted:
  flattened, stripped of control, zero-width and bidi characters, only drawn. Other states: `Loading tickets…`
  on the first fetch, `No active map. Run /trailhead:map to pick one.`, `No open tickets. Fog may remain: /trailhead:map`.
- **Where the data comes from**: `.trailhead/active-map` (read locally on `session.start` and
  `turn.complete`, whether or not the pane is open), then `gh issue view <map>` and
  `gh issue list --label trailhead:map-<map> --state open` through `$.process.run`. A result is
  dropped if the pane closed or the active map changed while `gh` ran.
- **When it refreshes**: only while the pane is open (a closed pane costs no `gh` call). Opening it,
  `session.start`, `turn.complete`, a Bash call that runs `gh issue edit|close|create|comment|reopen`,
  the `refresh` button, and a slow timer started on open. Never two fetches inside `MIN_REFRESH_MS`:
  a request inside the floor keeps one trailing refresh for the rest of it.
- **Auto-open**: once, in fullscreen (`e.viewport.isFullscreen === true` in the `AbovePrompt` render),
  when a map is active. Never on the main screen, never again after the pane was opened or closed
  by the person. The open runs from a zero-delay timer because a render may not write state.
- **Constants** (`map-pane.tsx`): `PANE_ID = 'trailhead-map'`, `PANE_TITLE = 'Map'`,
  `MIN_REFRESH_MS = 15_000`, `TIMER_MS = 180_000`, `GH_TIMEOUT_MS = 20_000`,
  `PANEL_COMMAND = 'trailhead:panel'`.
- **Atoms**: `mapPane`, `activeMap`, `pendingWork`, `paneAutoOpened`. Module variables hold only
  the queue and the timers.
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
  A healthy load logs `hooks module trailhead@inline loaded (...); events: session.start,turn.complete,tool.call,command.run,ui.render,ui.close,prompt.compose,session.compact,turn.start,session.end`.
  A module that fails to parse shows `hooks module did not load`.

## Optional type check

An interactive `--plugin-dir` load writes `.claude-plugin/types/` and an engine
`tsconfig.json` into the plugin (both are git-ignored). After that:

    npx -p typescript@5.9.3 tsc -p plugins/trailhead
