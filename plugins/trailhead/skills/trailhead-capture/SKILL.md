---
name: trailhead-capture
user-invocable: false
description: "trailhead capture cluster: the zero-friction captures that record work without breaking flow. Capture a bug ticket (bug), a small build ticket you will do now (todo), a fog idea (idea), a trigger-gated seed (seed), a verbatim note (note). A cohesion cluster of the trailhead skill split, loading the shared `_shared/` core; reached through the `/trailhead:<verb>` command wrappers and the bare `/trailhead` dispatcher. Not auto-invoked: it runs only when one of these verbs is dispatched."
argument-hint: "[bug|todo|idea|seed|note] [--of <ticket>] <text>"
---

`trailhead-capture` is the **capture cluster** of the trailhead skill: the zero-friction captures that record work without breaking flow. `bug` captures a bug ticket; `todo` captures a small build ticket you will do now; `idea` captures a fog idea; `seed` captures a trigger-gated seed; `note` captures a verbatim note. Everything lives on the GitHub Issues; the repo holds code only.

## Load first, in order

Before doing anything, read `../_shared/load-first.md` and follow it: the shared-core load contract (the six core files, in order, then the effective config). `_shared/` is a **sibling** of this cluster's own directory (at `../_shared/`), never a child of it; its absence from a listing of the cluster dir is expected, not a missing core.

A capture writes at most one issue; no isolation workspace is set up.

## Routing: verb to engine

The **first word** of the arguments is the verb (`bug`, `todo`, `idea`, `seed`, or `note`); the rest is the text (or `--of <ticket> <text>` for `bug`).

- **`bug`** / **`todo`** / **`idea`** / **`seed`** / **`note`** to **`references/capture.md`**: the full per-verb protocol and the note/idea/seed/todo spectrum. Read that file and follow it.

The cross-cluster situational references and technique bodies these captures call live in `_shared/`; this cluster names each by its `../_shared/...` path where it needs one.
