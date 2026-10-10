# trailhead mod (contributor note)

`register.ts` is the trailhead mod: a TypeScript hooks module that Claude Code loads
next to the command hooks. It is a scaffold for now: it registers a `session.start`
passthrough and the shared `trailhead.workState` atom, and nothing is visible yet.
The typed contract lives in `plugins/trailhead/types/index.d.ts`, wired through the
`types` key of `plugin.json`. The module is declared in `hooks/hooks.json` under
`"modules"` (exactly one path, relative to `hooks.json`).

## Requirements

- Claude Code 2.1.287 or newer (tested on 2.1.296).
- Command hooks stay the floor. A build without mod support skips only this module;
  every command hook keeps working.
- npm delivery is not done yet: `bin/trailhead.js` does not ship the mod, and the
  Codex projection never sees it. Only the plugin (`--plugin-dir`, marketplace) loads it.

## Dev loop

Run from the repo root.

- Hot reload: `claude --plugin-dir plugins/trailhead` (or set `CLAUDE_CODE_PLUGIN_DIRS`) in an
  interactive session. Saving `register.ts` reloads the module.
- Validate the manifest, types and module: `claude plugin validate plugins/trailhead`.
  It lists the hooked events and the declared state.
- Run the mod tests (every `*.test.ts` under the plugin): `claude plugin test plugins/trailhead`.
  Tests live in `plugins/trailhead/tests/`. The test `$` has no `state` noun, so do not read state there.
- Everything at once: `npm test`. It runs the `*.test.js` suites, then validate and test.
  Without `claude` on PATH it fails; set `TRAILHEAD_SKIP_MOD_CHECKS=1` to skip the mod checks.
- Debugging: `claude --debug`, or `claude -p --plugin-dir plugins/trailhead --debug-file <file> "say ok"`.
  A healthy load logs `hooks module trailhead@inline loaded (...); events: session.start`.
  A module that fails to parse shows `hooks module did not load`.

## Optional type check

An interactive `--plugin-dir` load writes `.claude-plugin/types/` and an engine
`tsconfig.json` into the plugin (both are git-ignored). After that:

    npx -p typescript@5.9.3 tsc -p plugins/trailhead
