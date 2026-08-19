# Prototype
A prototype is throwaway code that answers one open question. The question decides the shape — pick the branch before you build, because getting it wrong wastes the whole exercise.

- "Does this logic / state model feel right?" → a single shareable HTML file: free-play controls plus tabbed guided walkthroughs that push the state machine through the cases hard to reason about on paper, drivable by a non-developer.
- "What should this look like?" → several radically different UI variations on one route, switchable via a URL param and a floating bottom bar.

If genuinely ambiguous and the user's unreachable, default by context (backend module → logic; page/component → UI) and state the assumption at the top. Build the **cheapest concrete artifact** that settles it — outline, stub, static mockup, rough take. Optimise for reaction, not reuse: no tests, no error handling beyond runnable, no abstractions. Throwaway from day one and clearly labelled as such, sited next to the code it prototypes, trivial to run (one command or a double-clickable file). No persistence by default — surface the full relevant state after every action so the change is visible. Fold only the validated decision into real code — never let a prototype silently graduate into production.

**For UI tickets specifically:** before writing any real UI code, **ask the user whether they want mockups first** (default yes for a new screen). If yes, route by `config.design` (see [Configuration](#configuration)):
- **`disk` (default)** — a throwaway static HTML mockup next to the code, linked from the ticket as an asset (on a throwaway branch, out of main). Fast, self-contained.
- **`claude.ai/design` mode** — build the mockup in a Claude Design project so the user can edit it visually. On the **first** UI screen for this map, **ask whether to create a new project**; on yes, create it yourself via Claude Code's built-in **`design` skill** (a Claude Design canvas → Artifact) or the **`claude_design` MCP** (`/design-login`; project at `claude.ai/design/p/<id>`), then cache its URL in the project `.trailhead/config.json` under `design.project`. **Later screens reuse** that project (add an artboard). Link it back from the ticket. This path is Claude-integrated, not a trailhead dependency — verify the design skill/MCP is enabled for the account; if it isn't, fall back to `disk` and say so.

Either way the rough screen is **reacted to before real UI code**. How approval gates the build depends on `config.design.approval`:
- **`explicit` (default)** — surface the mockup and **wait for the user's clear go-ahead**; do not write UI code until they approve. Record the approval on the ticket, then proceed.
- **`auto`** — surface the mockup and **proceed without blocking** on a confirmation (the user can still object). Record the direction on the ticket.

