# trailhead mod (contributor note)

`register.tsx` is the trailhead mod: a TypeScript hooks module that Claude Code loads
next to the command hooks. It shows the ticket in play, read from `.trailhead/work-state.json`
(written by the skills through `templates/trailhead-work-state.js`; the mod only reads it).
The typed contract lives in `plugins/trailhead/types/index.d.ts`, wired through the
`types` key of `plugin.json`. The module is declared in `hooks/hooks.json` under
`"modules"` (exactly one path, relative to `hooks.json`). The pure parts (parsing the file,
the status text, the pipeline stages) are in `work-state-view.ts`.

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
  `fs.read`, `session.id` and `ui.status`, and the UI tests mount the band on `terminal` and `desktop`.
  A hook result is `{ value }` or `{ deny }`; a `$.fs.read` that must fail is a `{ deny: 'ENOENT: ...' }`.
  A `Text` carries no `key`, so the module keys a `Box` around each one and tests read the Text inside it.
- Everything at once: `npm test`. It runs the `*.test.js` suites, then validate and test.
  Without `claude` on PATH it fails; set `TRAILHEAD_SKIP_MOD_CHECKS=1` to skip the mod checks.
- Debugging: `claude --debug`, or `claude -p --plugin-dir plugins/trailhead --debug-file <file> "say ok"`.
  A healthy load logs `hooks module trailhead@inline loaded (...); events: session.start, turn.start, turn.complete, tool.call, session.end, ui.render`.
  A module that fails to parse shows `hooks module did not load`.

## Optional type check

An interactive `--plugin-dir` load writes `.claude-plugin/types/` and an engine
`tsconfig.json` into the plugin (both are git-ignored). After that:

    npx -p typescript@5.9.3 tsc -p plugins/trailhead
