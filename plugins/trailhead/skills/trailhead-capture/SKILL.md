---
name: trailhead-capture
user-invocable: false
description: "trailhead capture cluster: the zero-friction captures that record work without breaking flow. Capture a bug ticket (bug), a small build ticket you will do now (todo), a fog idea (idea), a trigger-gated seed (seed), a verbatim note (note). A cohesion cluster of the trailhead skill split, loading the shared `_shared/` core; reached through the `/trailhead:<verb>` command wrappers and the bare `/trailhead` dispatcher. Not auto-invoked: it runs only when one of these verbs is dispatched."
argument-hint: "[bug|todo|idea|seed|note] [--of <ticket>] <text>"
---

`trailhead-capture` is the **capture cluster** of the trailhead skill: the zero-friction captures that record work without breaking flow. `bug` captures a bug ticket; `todo` captures a small build ticket you will do now; `idea` captures a fog idea; `seed` captures a trigger-gated seed; `note` captures a verbatim note. Everything lives on the GitHub Issues; the repo holds code only.

## Load first, in order

Before doing anything, load `<skill base>/../_shared/load-first.md` and follow it: the shared-core load contract (the six core files, in order, then the effective config). `<skill base>` is this skill's **base directory** (Claude Code prints it as `Base directory for this skill:` when the skill loads; on another host, the directory holding this `SKILL.md`): resolve the path to an **absolute path** and open it with the **Read tool** on that absolute path. Never `cd` into a skills directory and never read a relative path from the shell (a `cd` compound followed by a read is denied by the search guard). The same rule covers every later `../_shared/...` or `references/...` path in this skill: resolve it against the base directory to an absolute path before reading. `_shared/` is a **sibling** of this cluster's own directory (at `../_shared/`), never a child of it; its absence from a listing of the cluster dir is expected, not a missing core.

A capture writes at most one issue; no isolation workspace is set up.

## Routing: verb to engine

The **first word** of the arguments is the verb (`bug`, `todo`, `idea`, `seed`, or `note`); the rest is the text (or `--of <ticket> <text>` for `bug`).

- **`bug`** / **`todo`** / **`idea`** / **`seed`** / **`note`** to **`references/capture.md`**: the full per-verb protocol and the note/idea/seed/todo spectrum. Read that file and follow it.

The cross-cluster situational references and technique bodies these captures call live in `_shared/`; this cluster names each by its `../_shared/...` path where it needs one.
