# Inbox: triaging issues opened by others

`/trailhead:inbox [issue]` triages issues that aren't trailhead tickets (bug reports, feature requests, questions) and **integrates the worthwhile ones into the map**, keeping the reporter's authorship.

`/trailhead:inbox` presents **two sections**:

**A. New: to triage.** Open issues carrying **no** `trailhead:*` label (plus any `trailhead:unverified` from the trust guard):
```bash
gh issue list --state open --json number,title,author,labels \
  | jq '[.[] | select([.labels[].name] | any(startswith("trailhead:")) | not)]'
```

**B. Parked fog: any ready to graduate?** The open `trailhead:fog` issues, **most-recently-active first**: recent discussion is exactly where the fog has likely cleared, so you review those, not all of them:
```bash
gh issue list --label trailhead:fog --state open --search "sort:updated-desc"
```
This is **how you notice a fog has cleared**: you don't watch each thread; you run the inbox (as you would to triage new issues), and section B surfaces the parked items that moved. For each, decide: **graduate** (adopt in place, see Fog of war), **keep parked** (still vague), or **drop** (turned out out-of-scope/dead → `trailhead:out-of-scope` + close). Optionally, a participant can nudge readiness by commenting on the thread; you confirm at graduation.

For each issue in either section, decide, with the user for judgement calls, on your own for clear ones:

- **Adopt → a ticket.** Integrate it *in place* (same issue number, so the reporter stays credited): append a trailhead block to the body: `Parent: <map name+link>`, `Adopted-from: opened by @<author>`, a reframed `## Question` (the decision/build the *map* will act on), and `## Blocked by`, **without erasing the reporter's original text above it**. Apply `trailhead:ticket` + the right type label (`bug`/`decision`/`build`/`research`/`task`) as a write-access maintainer (which also satisfies Trust & provenance); add `trailhead:blocked` if it has an open blocker. It lands on the frontier. Comment to the reporter that it's been picked up.
- **Fog.** In scope but not sharp enough to ticket → **keep the issue open and label it `trailhead:fog`** (parked: still visible and tracked, but the `trailhead:*` label drops it out of the inbound query, so it won't re-surface at every triage). Then use the open issue as a **clarification space**: post a comment with the questions that would make it concrete, in the spirit of **Grilling**, but async ("what would *done* look like? which users? where does it show?"), and invite the reporter and anyone interested to refine it in the thread. The fog dissipates through that conversation as much as through other work landing; others can carry the discussion with the reporter without you in the loop. **You don't lose it**: `gh issue list --label trailhead:fog` is the durable list, and the reporter follows their own open issue. When the thread (or the wider work) has made the question sharp, **adopt it in place**: swap `trailhead:fog` for `trailhead:ticket` + the type label, add `Parent:` and the now-answerable `## Question`, and it lands on the frontier: same issue, same reporter, the clarifying discussion preserved above.
- **Out of scope.** Beyond the destination → label `trailhead:out-of-scope`, close with the why.
- **Duplicate.** Link the existing ticket and close.
- **Needs info.** Ask the reporter for a repro or specifics; leave it open.

A rogue issue wearing a `trailhead:*` label it shouldn't (now `trailhead:unverified`) is triaged the same way: **adopt** (a maintainer applies the real labels + `Parent:`) or **reject** (strip the `trailhead:*` labels, leave it a normal inbound issue). Never adopt by trusting a label that was already there; you apply the labels on adoption.
