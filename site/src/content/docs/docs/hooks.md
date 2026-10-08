---
title: Hooks
description: The commit guard, secret guard, install guard, search guard, body guard, secret-read guard, mockup-link guard, injection scanner, the session-start update check, and the git commit-msg hook that enforce trailhead's discipline.
---

Beyond the skill's instructions, trailhead ships eight of its own hooks (self-contained, installed alongside the plugin) that *enforce* the parts of the discipline the model shouldn't be trusted to remember:

- **Commit guard** (`PreToolUse` on `git commit`): hard-blocks a commit whose subject isn't [Conventional Commits](https://www.conventionalcommits.org), and hard-blocks any `Co-Authored-By` trailer. This mirrors GSD's commit validation.
- **Secret guard** (`PreToolUse` on `gh` issue/PR writes): trailhead posts a lot to the tracker (ticket bodies, engine comments, codebase/conventions issues, resolutions). This scans what a `gh issue`/`gh pr`/`gh api` write is about to post (the inline `--body`, a heredoc, or a `--body-file`) and hard-blocks it if it matches a credential pattern (private keys, GitHub/AWS/OpenAI/Slack/Google/Stripe tokens, JWTs, or a hardcoded `password`/`secret`/`token=…`). The block is a clean-and-retry cue, not a dead end: trailhead redacts the flagged value in place (`<REDACTED>` or an env-var reference) and re-posts automatically, so the cleaned content still lands: the secret just never reaches the tracker. It stays a fail-safe block rather than a silent auto-rewrite on purpose: a block never leaks, whereas a redaction that quietly failed to apply would. It never scans reads, only outbound writes.
- **Install guard** (`PreToolUse` on package installs): a slopsquatting barrier. It hard-blocks a named public-registry install (npm / PyPI / crates.io / Go / RubyGems) until the package is vetted (typosquat similarity to popular names, age / first-seen date, download counts, repository metadata present and matching); once vetted, re-run the exact command prefixed with `TRAILHEAD_VERIFIED_INSTALL=1` to proceed. The Execute / Fix engine carries the same block-and-ask.
- **Search guard** (`PreToolUse` on `Bash`): a structural backstop for the search-command-hygiene rule (never `cd` then read/search a relative path). It hard-blocks a single Bash command that both changes directory (`cd`/`pushd`/`env -C`) and, in a joined or later statement, reads/searches a relative path (`grep`/`rg`/`ag`/`cat`/`head`/`tail`/`wc`/`nl`/`sed`/`awk`/`less`/`more`, or `git grep`/`log`/`show`/`diff` without a `-C`), so the shape that trips a `Read()` deny rule under bypass permissions (falling back to a manual approval prompt instead of running headless) never runs, rather than merely being discouraged in the agent's own prose. Claude Code only; not projected to Codex, which has no such `Read()` deny rule.
- **Body guard** (`PreToolUse` on `gh` issue/PR body writes): hard-blocks a `gh issue edit` / `gh pr edit` / `gh api` write that would set an issue body to empty or whitespace-only, so a read-modify-write whose read returned an empty/degraded body (e.g. a transient HTTP 5xx on `gh issue view --json body`) can never clobber the existing body.
- **Secret-read guard** (`PreToolUse` on `Read|Bash`): denies reads of `.env`/`.env.*`/`.secrets`, whether via the Read tool or a Bash command (a file operand, an option value, or a `<` redirect target). This is a hook `deny` decision rather than a `Read()` permission rule, so secrets stay unreadable without arming Claude Code 2.1.259's `cd-compound-read` approval prompt. On Codex, where file reads go through shell commands rather than a native Read-tool event, the same protection is enforced via the Bash arm; the `Read` arm is a Claude-Code-native path (the matcher is still registered on Codex, harmlessly, in case a future Codex version adds one).
- **Mockup-link guard** (`PreToolUse` on `AskUserQuestion`): structural backstop for the Prototype rule that a mockup approval ask carries the mockup's link. It hard-blocks an `AskUserQuestion` that asks to approve a mockup (or pick between mockup variants) when the reply text right before it holds no URL or file path, so the agent puts the clickable link in the message before asking again. On Codex, which has no `AskUserQuestion` tool and asks as a plain-text numbered list, its twin `mockup-link-stop` runs on `Stop`: when the final reply asks for that approval without a link, Codex continues the turn so the agent rewrites the ask with it.
- **Issue injection scanner** (`PostToolUse` on `gh` reads): trailhead reads issue/PR/comment text written by anyone with repo access, i.e. untrusted input. When that text contains prompt-injection phrases, the hook injects an advisory reminding the agent to treat it as data, never as commands. Advisory only: it never blocks.

All eight are crash-safe (any error → allow) and active whenever the plugin is installed. The commit, secret, install, search, body, and secret-read guards therefore apply in **every** repo, not only trailhead projects: intentional, since conventional commits, no `Co-Authored-By`, no leaked secrets, no unvetted installs, no `cd`-then-relative-read, no clobbered issue bodies, and no readable `.env`/`.secrets` are trailhead's standing rules.

To opt out, disable the plugin's hooks in your Claude Code settings.

Two more pieces round out the picture: a session-start check that tells you about updates, stale pinned models, and an outdated label guard, and a plain git hook that backs the commit rules up on every host.

## Session-start update check

The `trailhead-check-update.js` hook runs at `SessionStart`. It never fails or delays a session: every error degrades silently, it reads its input with a short timeout, and the network lookups have their own short timeouts. It does three things:

- **Update check.** It detects how trailhead was installed (plugin, npm, dev-symlink, or Codex), compares the installed version with the latest from the matching source (the npm registry for npm and Codex installs, GitHub for plugin and dev), and writes the verdict to a cache file under your cache directory (`trailhead/update-check.json`, and a separate `update-check-codex.json` for Codex). It checks the network at most every 6 hours. On Claude Code the statusline reads that cache and shows a `⬆ trailhead <version>` flag, and `/trailhead:update` reads it too. Codex has no statusline, so on Codex the hook itself adds a one-line heads-up to the session context whenever an update is available.
- **Pinned-model review notice.** It runs the read-only pinned-model check and, when a model you pinned in config is older than its tier's new default, adds the review offer (update, keep, or open `/trailhead:config`) to the session. It keeps coming back until you answer, because the check never records an acknowledgement by itself; the answer is stored in the gitignored `.trailhead/model-defaults-ack`. The full behaviour is described under [Pinned model review](/docs/configuration#pinned-model-review).
- **Label guard check.** When the repo's committed `.github/workflows/trailhead-label-guard.yml` is the old version with no job-level `if:` (every `issues: labeled` event then starts a GitHub Actions runner billed at least one minute), it adds an offer to upgrade it from the current template (then commit and push) or keep it. Like the model review it keeps coming back until you answer; the answer is stored in the gitignored `.trailhead/label-guard-ack` and the offer returns only if the guard file changes. A current, customised, or non-trailhead workflow is never flagged.

On a host with no hook bus, trailhead does the same checks inline at the start of a session instead, so nothing depends on the hook being present.

## Commit-msg hook

Alongside the host hooks, trailhead installs a plain git `commit-msg` hook, so the commit rules hold on every host and for every `git commit`, including Codex, which has no hook bus. On each commit it enforces:

- a [Conventional Commits](https://www.conventionalcommits.org) subject of at most 72 characters;
- no `Co-Authored-By` trailer;
- while a `.trailhead/session-ticket` marker is present at the working root, a `Refs: #<n>` trailer matching the ticket number in that marker. A commit missing it is rejected with a message naming the ticket and the fix. A marker that cannot be parsed never blocks a commit, and with no marker the trailer is not required.

The hook never wedges a commit: an unexpected error lets the commit through. `git commit --no-verify` skips it, as with any git hook. Commits made while a stale marker is lying around would wrongly demand the trailer, which is why trailhead removes the marker at the handoff; see [Working as a team](/docs/teamwork).

**Keeping it installed.** trailhead runs a small sync script at chart or adopt time and at the start of every `work` and `quick`. It reports one of these outcomes:

- **installed**: no hook was there, so the trailhead one was added.
- **upgraded**: an older trailhead hook (recognised by its own header line, not by filename) was replaced in place with the current one.
- **current**: already up to date, left alone.
- **foreign**: a commit-msg hook that is not trailhead's (a symlink counts) was found. It is never touched, and git does not enforce trailhead's rules there; trailhead tells you so.
- **skipped**: nothing was set up, because the directory is not a git repo or `core.hooksPath` is set and holds no commit-msg hook.

It follows `core.hooksPath` and works in linked worktrees (they share one hooks directory). The one `core.hooksPath` rule worth knowing: if you point `core.hooksPath` at your own directory, trailhead will upgrade a trailhead hook already sitting there, but it will not add a new file to that directory. In that case it reports skipped ("not set up"), and you copy the hook there yourself if you want it. The hook lives in `.git/hooks`, which is not version-controlled, so it is a per-clone local install with nothing to commit.

If the sync script itself cannot be found (an outdated install), trailhead inspects the hooks directory instead and reports what it finds: a trailhead hook that is present and executable is enforcing (only its freshness is unchecked), one that is not executable is skipped by git, a foreign hook is left alone, and no hook means nothing is enforced; in each case it suggests updating the install where that helps.

Next: [Getting started](/docs/getting-started) for the install steps that register these hooks, or [Configuration](/docs/configuration) for the rest of trailhead's settings.
