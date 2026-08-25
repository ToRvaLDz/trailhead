# Updating trailhead

`/trailhead:update` checks whether a newer trailhead exists and installs it **where that is safe**. The version check itself is deterministic (a shipped script, not a guess): the **`trailhead-check-update.js`** SessionStart hook writes a cache the statusline and this command read.

## 1. Read the check cache (refresh it if stale)

Read `${XDG_CACHE_HOME:-~/.cache}/trailhead/update-check.json`. It carries `{channel, installed, latest, updateAvailable, where, checkedAt}`. If it is **missing or older than a few hours**, refresh it first by running the check hook and re-reading:

```bash
# prefer the installed hook; on a dev-symlink install it may only live in the repo
HOOK="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/trailhead-check-update.js"
[ -f "$HOOK" ] || HOOK="<repoRoot>/plugins/trailhead/hooks/trailhead-check-update.js"   # `where` from the cache is the repo root on dev
rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/trailhead/update-check.json"   # force a fresh check (bypass the 6h throttle)
node "$HOOK"
```

If after this the cache still can't be read (no network, npm/gh unavailable), say so and stop: don't guess a version.

## 2. If already current, stop

If `updateAvailable` is `false`, tell the user they're on the latest (`installed` == `latest`) and stop. Nothing to do.

## 3. If newer, confirm, then install per channel

Show `installed → latest` and **confirm before touching anything** (auto-install, but with a go-ahead). Then act on `channel`:

- **`dev`** (skill symlinked to a checkout): the code is a git repo at `where`. Update in place:
  ```bash
  git -C "<where>" pull --ff-only
  ```
  Edits go live through the symlink, no reinstall needed. If the pull isn't fast-forwardable (local commits/changes), **stop and tell the user** rather than forcing it; let them reconcile.
- **`npm`** (installed via `npx @marcomigozzi/trailhead`): re-run the installer at the latest version, which copies the new files idempotently:
  ```bash
  npx -y @marcomigozzi/trailhead@latest
  ```
- **`plugin`** (installed via the Claude Code marketplace): the update is a **Claude Code command**, which this session cannot run for the user. Tell them to run **`/plugin update trailhead`** themselves (and `/plugin marketplace update trailhead` first if the marketplace is stale).

## 4. After a successful auto-update

For `dev`/`npm`, once the update lands: **refresh the check cache** so the statusline's `⬆` flag clears (`rm` the cache and re-run the hook, as in step 1), then tell the user to **restart or reload the agent** so the new skill, commands, and hooks are picked up. Report the new version plainly (`now on <latest>`).

## 5. Verify the install landed cleanly, and offer to fix

After the cache refresh, run a **lightweight integrity check** (fs existence plus the version compare already in hand: no tests, no extra network) and, on any failure, **surface it and offer to fix, never fix silently**:

- **Version settled.** Re-read the refreshed cache: `updateAvailable` should now be `false` with `installed == latest`. If it is **still `true` right after a successful update**, the version sources disagree, classically the source `plugin.json` / `marketplace.json` version lagging `package.json`, so the installed VERSION marker never reaches `latest`. Report this precisely; on the **dev** channel name the diverging files so the maintainer can reconcile them in a release commit. Do **not** edit any version file here (the rule below stands): this command reports the divergence, it does not patch it.
- **Engine surface present** (re-runnable, so offer the fix). Check the install has what it should for the host, and if anything is missing say what and why it matters, then **offer to re-run the installer** to place it (ask first, never auto-run):
  - **Claude**: the `trailhead-*` **agents** resolve as subagent types (present under `${CLAUDE_CONFIG_DIR:-~/.claude}/agents/`, or plugin-registered), the engine skill dirs and the `/trailhead:*` commands exist, and the hooks are registered in `settings.json`. **Absent agents are the high-value catch**: without them every technique runs inline on the session model, silently dropping the `config.models.*` split, so flag it and offer `node bin/trailhead.js --claude` (dev/npm) or `npx -y @marcomigozzi/trailhead@latest`.
  - **Codex**: the projected skill under `skills/trailhead/`, the `~/.codex/agents/trailhead-*.toml` registry, and `features.multi_agent_v2` in `config.toml`; offer the `--codex` reinstall if missing.
- **All clear**: say so in one line alongside `now on <latest>` (e.g. `install verified: agents, commands, hooks, version all in place`).

The check is lightweight and degrades silently: a probe that can't run (an unreadable path, a host detail absent) is reported as unchecked, never a hard failure of the update.

Never edit `package.json`/`plugin.json` versions here: this command **consumes** releases, it does not cut them.
