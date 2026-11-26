// The update button of the map pane (#400): what the update-check cache says, and the wording. Pure, no host.
// The cache is the one trailhead-check-update.js writes for Claude Code (`update-check.json`).

// Same pattern as the hook's SEMVER: the cache is the hook's, so its idea of a version is too.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// XDG_CACHE_HOME, else HOME/.cache, as the hook. The mod has no os.homedir(): with neither set there is no path
// (the hook would fall back to the OS home), so no button.
export const updateCachePath = (env: { xdg?: string; home?: string }): string | null => {
  const base = env.xdg !== undefined && env.xdg !== '' ? env.xdg : env.home !== undefined && env.home !== '' ? `${env.home}/.cache` : null
  return base === null ? null : `${base}/trailhead/update-check.json`
}

// The version to offer, or null: anything but a true verdict with a semver `latest` draws no button.
export const parseUpdateCheck = (text: string): { latest: string } | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { updateAvailable, latest } = parsed as { updateAvailable?: unknown; latest?: unknown }
  if (updateAvailable !== true || typeof latest !== 'string') return null
  const clean = latest.trim().replace(/^v/, '')
  return SEMVER.test(clean) ? { latest: clean } : null
}

export const updateLabel = (latest: string): string => `update to ${latest}`

// After the press: the command was asked for, not known to have finished (its outcome is in the conversation).
export const updateNote = (latest: string): string => `update to ${latest} requested: once it installs, reload plugins or restart Claude Code`
