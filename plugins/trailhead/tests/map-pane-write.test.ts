import { expect, test } from 'claude-code/testing'

import { GH_ISSUE_WRITE, isTrackerWrite } from '../hooks/mod/map-pane'

// A heredoc that writes a body file, as the model usually runs before a tracker write.
const HEREDOC = "cat > /tmp/x.md <<'EOF'\nbody line\nEOF"

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
  // multi-line: a heredoc before the write, or a line on either side of it
  `${HEREDOC}\ncd /repo && gh issue edit 325 --title "t"`,
  `${HEREDOC}\ngh issue create --body-file /tmp/x.md`,
  `${HEREDOC}\ngh issue comment 5 --body-file /tmp/x.md`,
  'echo hi\ngh issue close 5',
  'gh issue close 5\necho hi',
  `${HEREDOC}\nnode /x/templates/trailhead-issue-body.js append --issue 198 --section "Decisions so far" --line x`,
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
  // multi-line reads
  `${HEREDOC}\ngh issue view 5`,
  `${HEREDOC}\ngh issue list --state open`,
  'cd /repo\ngh api repos/o/r/issues/5',
]

test('the write matcher takes the tracker writes of a Bash call', () => {
  for (const command of WRITES) expect([command, GH_ISSUE_WRITE.test(command)]).toEqual([command, true])
})

test('the write matcher leaves reads alone', () => {
  for (const command of READS) expect([command, GH_ISSUE_WRITE.test(command)]).toEqual([command, false])
})

// A heredoc body is data, not commands: [command, is it a tracker write]. `\t` is a tab.
const HEREDOCS: Array<[string, boolean]> = [
  ['cat >f <<EOF\ngh issue close 5\nEOF', false],
  ["cat >f <<'EOF'\ngh issue close 5\nEOF", false],
  ['cat >f <<"EOF"\ngh issue close 5\nEOF', false],
  ['cat >f <<-EOF\n\tgh issue close 5\n\tEOF', false],
  ['cat <<A >a; cat <<B >b\ngh issue close 1\nA\ngh issue edit 2\nB', false],
  ['cat <<A >a; cat <<B >b\nx\nA\ny\nB\ngh issue close 3', true],
  ['gh issue create --body-file - <<EOF\nbody\nEOF', true],
  ['gh issue comment 5 -F - <<EOF\ngh issue close 9\nEOF', true],
  ["cat <<'EOF' >x\nb\nEOF\ngh issue close 5", true],
  ["cat <<'EOF' >x\nEOF2\ngh issue close 5\n EOF\nEOF", false],
  ["cat <<'EOF' >x\ngh issue close 5", false],
  ['cat <<-EOF >x\nb\n  EOF\ngh issue close 5\nEOF', false],
  ["cat <<< 'x'\ngh issue close 5", true],
  ['echo $((1<<2))\ngh issue close 5', true],
  ['echo $((1<<2)); gh issue view 5', false],
  ["cat <<'EOF' >x\nnode trailhead-issue-body.js append\nEOF", false],
  ['echo "a <<EOF"\ngh issue close 5', true],
]

test('isTrackerWrite takes the writes and leaves the reads', () => {
  for (const command of WRITES) expect([command, isTrackerWrite(command)]).toEqual([command, true])
  for (const command of READS) expect([command, isTrackerWrite(command)]).toEqual([command, false])
})

test('isTrackerWrite ignores a heredoc body and keeps a write around it', () => {
  for (const [command, verdict] of HEREDOCS) expect([command, isTrackerWrite(command)]).toEqual([command, verdict])
})
