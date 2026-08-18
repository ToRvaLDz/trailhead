# Acceptance testing
Automated tests prove the code does what the *code* intended; acceptance testing proves it does what the *user* wanted. After tests + code review pass, decide whether the change needs acceptance testing (user-facing behaviour usually does; a pure refactor or internal util usually doesn't) and pick the cheapest sufficient path:

- **Automated first.** Run the ticket's test/criterion and the suite. If that fully covers the behaviour, you're done.
- **Browser-drivable web app → drive it yourself.** Governed by `config.acceptance.browser` + `config.testing`: when it's `auto`/`on` and `testing.webapp` + `testing.url` are set, use the browser-automation tools to exercise the actual change end-to-end (navigate, fill, click, assert visible state; capture a screenshot into the `VERIFY` comment). Prefer this over asking the human when the flow is scriptable. Never trigger native/JS dialogs that would wedge the session.
- **Needs human judgement → guided UAT.** When only a person can judge it (visual polish, feel, real credentials, hardware), hand them a **numbered checklist**: exact steps, the expected result per step, and where to click. Record their pass/fail per step in the `VERIFY` comment. Don't close on green you didn't actually see.

Acceptance failures are findings like any other: a `bug` follow-up or a fix on this ticket before it resolves.

