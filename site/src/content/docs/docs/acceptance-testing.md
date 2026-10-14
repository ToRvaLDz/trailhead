---
title: Acceptance testing
description: How trailhead's Verify runs a UAT on every user-facing change, driving the browser or connected devices itself when it can and walking you through the rest step by step.
---

Passing tests prove the code does what the *code* intended; acceptance testing proves it does what *you* wanted. For anything you can see (a new screen, data that now appears, a changed flow), a green suite **does not close the ticket**: Verify runs a UAT too, after tests and code review.

## How a UAT runs

1. **It asks who drives.** Before any step runs: **AI-driven** or **human-driven**. It waits for a clear answer (silence re-asks). If no step is something the agent can do this session (a device it can't reach, credentials it doesn't hold, a judgement of feel or sound), it skips the ask, goes human-driven and tells you why in one line.
2. **AI-driven: it drives the app itself.** For a web app it finds the target URL on its own (a running dev server, the `dev` script, the framework's configured port), proposes it for you to confirm, then navigates, fills, clicks and asserts what's on screen, with a **screenshot as evidence** in the ticket's `VERIFY` comment. **Beyond the browser, it drives whatever device the session can reach**: a phone or emulator over `adb`, an iOS simulator, a smart TV, a desktop app, through the commands and tools you have connected (a device MCP, computer use, the platform's CLI). Only the steps it truly can't do come back to you, one at a time.
3. **Human-driven, or what the agent can't reach: a guided walkthrough.** A device that isn't connected, an account it doesn't hold, a call on feel or sound: trailhead walks you through it **one step at a time in the chat** (what to do, where to tap, what you should see), waits for what you actually saw, then moves on. Never a checklist dumped on you to self-serve.
4. **Against the approved mockup.** When the ticket had one, the built screen is checked against it **element by element and state by state** (layout, spacing, colour, type, copy; empty, loading, error, disabled…), from the re-read mockup, never from memory. An unforced deviation is a finding, not "close enough".
5. **Failures become tickets on the spot.** A failed step records expected vs. seen and opens a `bug` follow-up (or a fix on this ticket) right away, then asks whether to carry on.
6. **Nothing slips through as "done".** If the UAT can't run now (the device isn't at hand, the backend isn't deployed), trailhead asks: run it now, or open a follow-up ticket (`UAT of: #<n>`) that carries the full checklist. A user-facing ticket never closes on a UAT nobody ran.

## What it looks like

```text
trailhead › Tests and review are green. Who drives the UAT: AI or you?   → AI
trailhead › Acceptance will run against http://localhost:5173, correct?   → yes
trailhead › ✓ Sign in with GitHub → lands on /dashboard        (screenshot)
            ✓ Login-B vs. the build: 14/14 elements, 4/4 states match
            ✓ Android app on the connected phone (adb): GitHub sign-in → home  (screenshot)
            ? Step 6 is the haptic on "Signed in": does it buzz once, softly?
```

## Configuration

`acceptance.browser` (`auto` default, `on`, `off`) governs browser driving; `off` keeps AI-driven checks via commands and the suite, and still asks who drives. `testing.webapp` / `testing.url` say whether the app is browser-drivable and where. Under `/trailhead:auto`, it goes AI-driven; steps only you can do are never faked: the ticket is set aside and listed in the run's summary.

Next: [Design mockups](/docs/design) for how the mockup that acceptance checks against is made; the `acceptance` and `testing` keys are in [Configuration](/docs/configuration).
