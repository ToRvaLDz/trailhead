---
title: Design mockups
description: How trailhead mocks up UI before writing code, on a Claude Artifacts canvas, Google Stitch or local disk, and how to move from claude.ai/design.
---

For any ticket that changes user-facing UI (a new screen, a redesign, a changed layout), trailhead mocks the screen up **before** writing UI code. You react to the mockup, approve it, and the build then reproduces it faithfully. Where the mockup lives is the `design` key in [Configuration](/docs/configuration#design-mockups).

| `design` | Where the mockup lives | Hosts |
|---|---|---|
| **`disk`** (default) | a throwaway static HTML file next to the code, linked from the ticket | any |
| `artifacts` | a **Design canvas Artifact** on claude.ai, editable, commentable and exportable | Claude Code signed in with a claude.ai account |
| `stitch` | a **Google Stitch** project (or Stitch design system) | Claude Code and Codex |

## Mockups on Claude Artifacts

`design: artifacts` uses Claude Code's built-in `Artifact` tool: there is no MCP server to install and no extra login.

1. **A canvas per map.** On the first UI screen of a map, trailhead attaches a Design canvas: it lets you **pick an existing one**, **paste its URL**, or **create a new one** (it asks you for the name, it never invents it). The canvas URL is cached in `design.project` in `.trailhead/config.json`, and every later screen of the map lands on the same canvas.
2. **Your design system on the canvas.** The Design System Artifact named in `design.system` is installed on the canvas, so the editor offers its colours and text styles and its components are mounted instead of look-alikes. If the key is unset, trailhead uses your account's default design system, or lists the ones you have and asks which (or none), then caches the choice. The design system is a read-only reference: screens are never written into it.
3. **One artboard per screen.** Every screen, and every structurally different variant, is its own artboard, grouped in a canvas **page named after the ticket**, so each ticket's mockups are easy to find. App screens get a fixed frame (for example a 390×844 phone), web pages and dashboards a fluid one. A single artboard is at most 8000px tall, so a very long page is split into consecutive artboards.
4. **Approve with the link in front of you.** The approval message always carries the canvas URL and the name of each artboard it asks about (artboards have no URL of their own), right before the question; the [mockup-link guard](/docs/hooks) blocks an approval ask that has no link.
5. **Edit freely, then approve.** You can change the mockup directly on the canvas or leave comments there. Once you approve (`design.approval: explicit`, the default) or right before the build consumes it (`auto`), trailhead **re-reads** the approved artboards and builds from that version, not from what it last published.
6. **Faithful build.** The approved artboards are the spec: layout, spacing, colour, type, copy and every state they show. Acceptance testing checks the built screen against them element by element.

Artifacts are private: share the canvas from its Share menu before sending the link to someone else.

## Mockups on Google Stitch

`design: stitch` uses the Google Stitch MCP, which runs on both Claude Code and Codex:

```bash
claude mcp add --scope user --transport http stitch https://stitch.googleapis.com/mcp
```

`design.surface` picks a Stitch project of screens (`canvas`, default) or a shared Stitch design system (`design-system`). On the first screen trailhead lets you pick, paste or create one and caches its id in `design.project`. If the MCP isn't connected, trailhead offers to install it once; decline and it falls back to local disk, saying so.

## When the configured mode isn't available

trailhead never silently swaps a hosted mode for a local file. Where the `Artifact` tool is missing (on Codex, or in a Claude Code session authenticated with an API key instead of a claude.ai account), `artifacts` can't run, so trailhead offers once to switch the project to `stitch` and only on decline falls back to a disk mockup, telling you why.

## Moving from claude.ai/design

The standalone Claude Design site (claude.ai/design) closes on **December 14, 2026**. Claude Design now lives inside Claude, and new designs, design systems and decks are Artifacts. trailhead follows: the hosted mode is now `artifacts`, and trailhead no longer uses the `claude-design` MCP or DesignSync for mockups.

What changes for a project that used `design: claude.ai/design`:

- **The config keeps working.** `claude.ai/design` is read as `artifacts`; trailhead tells you once and offers to rewrite the key through `/trailhead:config`.
- **The old project can't be reused.** A `design.project` that points at a claude.ai/design project is not an Artifact, so trailhead says so and attaches a new canvas at the next UI screen.
- **`design.surface: design-system` no longer applies** to Claude: screens go on a canvas and the design system is installed on it through `design.system`. The `design-system` surface remains for Stitch.

The migration of your existing material is manual, and worth doing before the site closes:

1. **Design systems.** Open the **Artifacts** page in Claude and click **Migrate team design systems** in the banner. Each design system becomes a Design System Artifact; review the ones listed under *Couldn't be migrated* and fix them from the standalone site. Then point `design.system` at the migrated one (or let trailhead ask at the next screen).
2. **Projects.** Projects don't migrate yet. From each standalone project, use **Share → Project HTML → Project archive** to download a free `.zip` of its files. You can then ask trailhead (or Claude Code) to rebuild the screens you still need on a Design canvas; a project already made of `.dc.html` files moves over almost as-is, while images have to come from the archive.
3. **Chats and comments** are not carried over: save what you need before the closing date.
4. **Team and Enterprise owners**: Artifacts, design systems and Design/Slides templates must be enabled in *Organization settings › Artifacts*; organizations with zero data retention can't use Artifacts and should download their projects.

Next: [Hooks](/docs/hooks) for the guardrails, including the mockup-link guard; the `design` keys are in [Configuration](/docs/configuration#design-mockups).
