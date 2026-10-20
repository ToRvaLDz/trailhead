import { expect, test } from 'claude-code/testing'

import { GH_ISSUE_WRITE } from '../hooks/mod/map-pane'

// Bash commands the pane refreshes on (a write to the tracker) and ones it must ignore.
const WRITES = [
  'gh issue close 5',
  'gh --repo o/r issue close 5',
  'gh issue comment 5 -b hi',
  'gh issue edit 5 --add-label x',
  'gh issue create -t t',
  'gh issue reopen 5',
  'gh issue delete 5',
  'gh issue transfer 5 o/other',
  'env GH_HOST=x gh issue close 5',
  'command gh issue close 5',
  'cd x && gh issue close 5',
  'gh api -X POST repos/o/r/issues/198/sub_issues -F sub_issue_id=1',
  'gh api repos/o/r/issues/198/sub_issues -F sub_issue_id=1',
  'gh api repos/{owner}/{repo}/issues/5 -f state=closed',
  'gh api --method=PATCH repos/o/r/issues/5',
  'gh api --method PATCH repos/o/r/issues/5 -f title=x',
  'gh api -XDELETE repos/o/r/issues/5/labels/x',
  'gh api "repos/o/r/issues/5/comments" -f body=hi',
  "gh api -X PUT 'repos/o/r/issues/5/lock'",
  'gh api repos/o/r/issues/5 --input body.json',
  'node /x/templates/trailhead-issue-body.js append --issue 198 --section "Decisions so far" --line x',
]
const READS = [
  'gh issue list --state open',
  'gh issue view 5',
  'ls -la',
  'gh pr close 4',
  'gh api repos/o/r/issues/5',
  'gh api repos/o/r/issues --jq length',
  'gh api -X GET repos/o/r/issues -f labels=x',
  'gh api --method=GET repos/o/r/issues -F per_page=1',
  'gh api graphql -f query=query{viewer{login}}',
  'gh api graphql -F owner={owner} -F repo={repo} -f query=x',
  'gh api repos/o/r/pulls -f state=open',
  'git log && echo gh issue',
  'gh api repos/o/r/issues/5 | jq . ; echo -f x',
]

test('the write matcher takes the tracker writes of a Bash call', () => {
  for (const command of WRITES) expect([command, GH_ISSUE_WRITE.test(command)]).toEqual([command, true])
})

test('the write matcher leaves reads alone', () => {
  for (const command of READS) expect([command, GH_ISSUE_WRITE.test(command)]).toEqual([command, false])
})
