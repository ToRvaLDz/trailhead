# Code review: pipeline reliability

Loaded only on a pipeline-touching diff (see **Pipeline reliability** in `code-review.md`). It is not a sixth axis: findings use the same IDs, counts line and ledger as the other axes.

**Scope.** Review only jobs and steps the ticket's commits add or change, per the Ticket diff rule in `code-review.md`; the rest of the file is context.

**Checks.** Look for each of these in the in-scope jobs and steps:

- **Install ignoring the lockfile**: `npm install` where a lockfile exists (use `npm ci` instead).
- **No timeout**: a job without `timeout-minutes`.
- **No concurrency group**: a deploy without a `concurrency` group.
- **Rebuild per environment**: a rebuild per environment instead of build once, promote. It applies only when the workflow targets more than one environment.
- **No safety net on a deploy**: a deploy with neither a health check nor a rollback (either one present is enough).
- **Swallowed failure**: `continue-on-error` on a step that later steps depend on.
- **Static cloud credentials**: static cloud keys where the provider supports OIDC.
- **Floating action ref**: a third-party action on `@main` or `@latest`.

**Severity.** Every finding is a Warning, never Critical, so it never enters the Critical-only fix-and-re-review loop.

**Not findings**: global tool installs (`npm install -g`), reusable workflows (a job calling one takes neither `timeout-minutes` nor steps of its own), actions already pinned to a tag, and test-only workflows (a workflow that runs tests and publishes or deploys nothing: none of the checks apply).

**Secrets.** Hardcoded secrets are not in this reference: they stay Critical under the Security axis.

**Naming a deploy.** A deploy finding names what makes the workflow a deploy one (a quoted command, an `environment:`, a target).
