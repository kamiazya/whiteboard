#!/usr/bin/env node
// Coverage for hook-command-lib.mjs. Run with: pnpm test:scripts.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { prActionFromHookInput, runsGitPush } from './hook-command-lib.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'hook-command-lib-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** The action a Bash call carries, read the way a hook reads its stdin. */
const fromCommand = (command, options = {}) =>
  prActionFromHookInput(
    { tool_name: 'Bash', tool_input: { command } },
    { cwd: scratch, ...options },
  )

test('a gh subcommand is matched at a command position', () => {
  for (const command of [
    'gh pr merge 12 --squash',
    'cd /x && gh pr merge 12',
    'git status; gh pr merge 12',
    'true || gh pr merge 12',
    'echo done | gh pr merge 12',
    'GH_TOKEN=x gh pr merge 12',
    'a\ngh pr merge 12',
    'gh   pr   merge',
  ]) {
    assert.equal(fromCommand(command)?.action, 'merge', command)
  }
})

test('text that merely mentions a gh subcommand is not a command', () => {
  for (const command of [
    "git commit -m 'note: gh pr merge 2029 later'",
    "printf 'gh pr merge 1'",
    'echo gh pr merge 1',
    'grep -rn "gh pr merge" .claude',
    'gh pr mergeable',
    'gh pr view 12',
  ]) {
    assert.equal(fromCommand(command), null, command)
  }
  assert.equal(fromCommand("git commit -m 'gh pr create later'"), null)
  assert.equal(fromCommand('gh pr create --title x')?.action, 'create')
})

test('the PR number is read from the command only where it is a command', () => {
  assert.equal(fromCommand('gh pr merge 1751 --squash --delete-branch')?.pr, 1751)
  assert.equal(fromCommand('cd /x && gh pr merge 42 --squash')?.pr, 42)
  assert.equal(fromCommand('gh pr merge --squash')?.pr, null)
  assert.equal(fromCommand('gh pr create --title x')?.pr, null)
  assert.equal(fromCommand("git commit -m 'gh pr merge 9'"), null)
})

test('the gh pr create form reads its body, branch and checkout as the hooks always have', () => {
  const quoted = fromCommand(`cd /x && gh pr create --head feat --title x --body "a \\"b\\""`)
  assert.equal(quoted?.form, 'gh-pr')
  assert.equal(quoted?.cd, '/x')
  assert.equal(quoted?.head, 'feat')
  assert.deepEqual(quoted?.body, { text: 'a "b"' })
  writeFileSync(join(scratch, 'gh-body.md'), 'from a file')
  assert.deepEqual(fromCommand('gh pr create --body-file gh-body.md')?.body, {
    text: 'from a file',
  })
  // An editor, --fill or stdin: nothing here can read it, and the form fails open.
  assert.equal(fromCommand('gh pr create --fill')?.body, null)
})

// The two forms carry the same body, so they must read it the same: a gh pr
// form that misreads a quoting the REST form understands blocks a body that
// does state its skip, and only on the form the reader happened to type.
test('the gh pr and REST forms read every shell quoting of a body alike', () => {
  const rest = 'gh api -X POST repos/{owner}/{repo}/pulls -f head=feat -f body='
  for (const [quoted, text] of [
    [`$'Visual evidence: none - docs only\\nmore'`, 'Visual evidence: none - docs only\nmore'],
    ['Visual\\ evidence:\\ none\\ -\\ docs', 'Visual evidence: none - docs'],
    [`"say \\"hi\\""'; tail'`, 'say "hi"; tail'],
    [`'single'"double"`, 'singledouble'],
  ]) {
    assert.deepEqual(fromCommand(`${rest}${quoted}`)?.body, { text }, `REST: ${quoted}`)
    assert.deepEqual(
      fromCommand(`gh pr create --title t --body ${quoted}`)?.body,
      { text },
      `gh pr --body: ${quoted}`,
    )
    assert.deepEqual(
      fromCommand(`gh pr edit 5 --body=${quoted}`)?.body,
      { text },
      `gh pr --body=: ${quoted}`,
    )
  }
  writeFileSync(join(scratch, 'spaced body.md'), 'from a spaced path')
  assert.deepEqual(fromCommand('gh pr create --body-file spaced\\ body.md')?.body, {
    text: 'from a spaced path',
  })
  assert.deepEqual(fromCommand(`gh pr create --body-file=$'spaced body.md'`)?.body, {
    text: 'from a spaced path',
  })
  // A body belongs to the gh pr command that carries it, not to the next one.
  assert.equal(fromCommand(`gh pr create --fill && echo --body 'x'`)?.body, null)
})

test('the gh pr form reads every spelling gh accepts for its body and head flags', () => {
  writeFileSync(join(scratch, 'short.md'), 'from -F')
  for (const flags of ['-b x', '-bx', '-b=x', '--body x', '--body=x']) {
    assert.deepEqual(fromCommand(`gh pr create -t t ${flags}`)?.body, { text: 'x' }, flags)
  }
  assert.deepEqual(fromCommand(`gh pr create -t t -b 'Visual evidence: none - a b'`)?.body, {
    text: 'Visual evidence: none - a b',
  })
  for (const flags of ['-F short.md', '-Fshort.md', '-F=short.md', '--body-file=short.md']) {
    assert.deepEqual(fromCommand(`gh pr create -t t ${flags}`)?.body, { text: 'from -F' }, flags)
  }
  assert.deepEqual(fromCommand('gh pr edit 5 -F short.md')?.body, { text: 'from -F' })
  for (const flags of [
    '-H feat',
    '-Hfeat',
    '-H=feat',
    '--head feat',
    '--head=feat',
    '-H me:feat',
  ]) {
    assert.equal(fromCommand(`gh pr create -t t ${flags}`)?.head, 'feat', flags)
  }
  // The head, like the body, belongs to the gh pr command that carries it.
  assert.equal(fromCommand(`gh pr create --fill && echo --head x -H y`)?.head, null)
  assert.equal(fromCommand('gh pr create --fill')?.head, null)
})

test('a flag given twice reads its last occurrence, as gh does', () => {
  // gh's flag parser overwrites a repeated flag, so what it submits is the LAST
  // value; a hook reading the first would judge a body gh never sends.
  assert.deepEqual(fromCommand('gh pr create -t t -b first -b second')?.body, { text: 'second' })
  assert.deepEqual(fromCommand('gh pr create -t t --body=first -bsecond')?.body, {
    text: 'second',
  })
  assert.equal(fromCommand('gh pr create -t t --head one -H=two')?.head, 'two')
})

test('the REST calls behind gh pr create, merge and edit are recognised', () => {
  const create = fromCommand(
    "gh api -X POST repos/{owner}/{repo}/pulls -f title=x -f head=feat -f base=main -f body='Visual evidence: none — n/a'",
  )
  assert.equal(create?.action, 'create')
  assert.equal(create?.form, 'rest')
  assert.equal(create?.repo, '{owner}/{repo}')
  assert.equal(create?.head, 'feat')
  assert.deepEqual(create?.body, { text: 'Visual evidence: none — n/a' })

  for (const command of [
    'gh api --method=POST /repos/kamiazya/whiteboard/pulls -f head=kamiazya:feat',
    'gh api repos/kamiazya/whiteboard/pulls -f head=feat -f base=main -f title=x',
    'gh api -XPOST https://api.github.com/repos/kamiazya/whiteboard/pulls --raw-field=head=feat',
    'cd /x && gh api --method post repos/kamiazya/whiteboard/pulls -F head=feat',
  ]) {
    const action = fromCommand(command)
    assert.equal(action?.action, 'create', command)
    assert.equal(action?.head, 'feat', command)
    assert.equal(action?.repo, 'kamiazya/whiteboard', command)
  }

  const merge = fromCommand(
    'gh api -X PUT repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash',
  )
  assert.equal(merge?.action, 'merge')
  assert.equal(merge?.pr, 12)
  assert.equal(merge?.form, 'rest')
  const mergeNamed = fromCommand('gh api --method PUT repos/kamiazya/whiteboard/pulls/2041/merge')
  assert.deepEqual([mergeNamed?.pr, mergeNamed?.repo], [2041, 'kamiazya/whiteboard'])
  // The head check a careful merge makes first is a read, not a merge.
  const chained = fromCommand(
    'sha=$(gh api repos/{owner}/{repo}/pulls/5 --jq .head.sha) && gh api -X PUT repos/{owner}/{repo}/pulls/5/merge -f sha="$sha"',
  )
  assert.deepEqual([chained?.action, chained?.pr], ['merge', 5])

  const edit = fromCommand("gh api -X PATCH repos/{owner}/{repo}/pulls/12 -f title='feat: x'")
  assert.deepEqual([edit?.action, edit?.pr], ['edit', 12])
})

test('a hook guarding one action finds it behind another in the same command', () => {
  const both = 'gh pr create --title x && gh pr merge 5 --squash'
  assert.equal(fromCommand(both)?.action, 'create')
  assert.equal(fromCommand(both, { action: 'merge' })?.pr, 5)
  const rest =
    'gh api -X PATCH repos/{owner}/{repo}/pulls/5 -f title=x && gh api -X PUT repos/{owner}/{repo}/pulls/5/merge'
  assert.equal(fromCommand(rest, { action: 'merge' })?.form, 'rest')
  assert.equal(fromCommand(rest, { action: 'create' }), null)
  const mcpMerge = {
    tool_name: 'mcp__github__merge_pull_request',
    tool_input: { owner: 'o', repo: 'r', pullNumber: 1 },
  }
  assert.equal(prActionFromHookInput(mcpMerge, { action: 'create' }), null)
})

test('a REST read, another endpoint, or a mention is not a PR action', () => {
  for (const command of [
    'gh api repos/{owner}/{repo}/pulls/12 --jq .head.sha',
    'gh api repos/{owner}/{repo}/pulls/12/comments --paginate',
    "gh api 'repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open'",
    'gh api -X GET repos/{owner}/{repo}/pulls -f state=open',
    // Only a field sends parameters; a filter or header holding `=` is still a GET.
    "gh api repos/{owner}/{repo}/pulls --jq '.[] | select(.draft == false) | .number'",
    'gh api repos/{owner}/{repo}/pulls -q \'.[] | select(.head.ref == "x")\'',
    "gh api repos/{owner}/{repo}/pulls -H 'X-Probe=1'",
    'gh api repos/{owner}/{repo}/pulls/12/merge',
    'gh api -X POST repos/{owner}/{repo}/issues/12/comments -f body=x',
    'gh api -X POST repos/{owner}/{repo}/pulls/12/reviews -f event=COMMENT',
    'echo gh api -X PUT repos/o/r/pulls/1/merge',
    "git commit -m 'gh api -X PUT repos/o/r/pulls/1/merge'",
  ]) {
    assert.equal(fromCommand(command), null, command)
  }
})

test('a REST body is read from wherever gh api takes it', () => {
  writeFileSync(join(scratch, 'pr.md'), '## Visual repro\n![f](https://example.invalid/f.png)')
  writeFileSync(join(scratch, 'pr.json'), JSON.stringify({ head: 'lane', body: 'from json' }))
  const create = 'gh api -X POST repos/{owner}/{repo}/pulls -f head=feat'

  assert.match(fromCommand(`${create} -F body=@pr.md`)?.body?.text ?? '', /Visual repro/)
  assert.deepEqual(fromCommand(`${create} -f body=@pr.md`)?.body, { text: '@pr.md' })
  assert.deepEqual(
    fromCommand(create)?.body,
    { text: '' },
    'a create with no body has an empty one',
  )

  const input = fromCommand('gh api -X POST repos/{owner}/{repo}/pulls --input pr.json')
  assert.deepEqual([input?.body, input?.head], [{ text: 'from json' }, 'lane'])

  const heredoc = fromCommand(`${create} -F body=@- <<'EOF'\nVisual evidence: none — a hook\nEOF`)
  assert.deepEqual(heredoc?.body, { text: 'Visual evidence: none — a hook' })
  const jsonHeredoc = fromCommand(
    `gh api -X POST repos/{owner}/{repo}/pulls --input - <<EOF\n${JSON.stringify({ head: 'x', body: 'b' })}\nEOF`,
  )
  assert.deepEqual([jsonHeredoc?.body, jsonHeredoc?.head], [{ text: 'b' }, 'x'])
  const ansi = fromCommand(`${create} -f body=$'line one\\nline two'`)
  assert.deepEqual(ansi?.body, { text: 'line one\nline two' })
})

test('a REST body nothing here can read says why instead of reading as empty', () => {
  const create = 'gh api -X POST repos/{owner}/{repo}/pulls -f head=feat'
  for (const command of [
    `cat pr.md | ${create} -F body=@-`,
    `${create} -F body=@missing.md`,
    'gh api -X POST repos/{owner}/{repo}/pulls --input missing.json',
    `printf x | gh api -X POST repos/{owner}/{repo}/pulls --input -`,
  ]) {
    const body = fromCommand(command)?.body
    assert.equal(typeof body?.unreadable, 'string', command)
    assert.equal(body?.text, undefined, command)
  }
})

test('a GitHub MCP tool call reads as the same action, with no command string', () => {
  const create = prActionFromHookInput({
    tool_name: 'mcp__github__create_pull_request',
    tool_input: { owner: 'o', repo: 'r', title: 'x', head: 'o:feat', base: 'main', body: 'b' },
  })
  assert.deepEqual(
    [create?.action, create?.form, create?.repo, create?.head, create?.body],
    ['create', 'mcp', 'o/r', 'feat', { text: 'b' }],
  )
  const merge = prActionFromHookInput({
    tool_name: 'mcp__github__merge_pull_request',
    tool_input: { owner: 'o', repo: 'r', pullNumber: 12, merge_method: 'squash' },
  })
  assert.deepEqual([merge?.action, merge?.pr, merge?.repo], ['merge', 12, 'o/r'])
  const edit = prActionFromHookInput({
    tool_name: 'mcp__github__update_pull_request',
    tool_input: { owner: 'o', repo: 'r', pullNumber: 3 },
  })
  assert.deepEqual([edit?.action, edit?.pr], ['edit', 3])
  // A number GitHub could never have issued names no PR, and a repo missing
  // either half names no repo.
  for (const pullNumber of [0, -1, 1.5, 'x', undefined]) {
    const odd = prActionFromHookInput({
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { owner: 'o', repo: 'r', pullNumber },
    })
    assert.equal(odd?.pr, null, String(pullNumber))
  }
  for (const halves of [{ owner: 'o' }, { repo: 'r' }]) {
    const half = prActionFromHookInput({
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { ...halves, pullNumber: 1 },
    })
    assert.equal(half?.repo, '{owner}/{repo}', JSON.stringify(halves))
  }
  assert.deepEqual(
    prActionFromHookInput({
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { owner: 'o', repo: 'r', head: 'feat' },
    })?.body,
    { text: '' },
  )
  assert.equal(
    prActionFromHookInput({ tool_name: 'mcp__github__get_pull_request', tool_input: {} }),
    null,
  )
  assert.equal(prActionFromHookInput(undefined), null)
})

test('git push is matched through global flags, and not inside a message', () => {
  for (const command of [
    'git push',
    'git push -u origin feat',
    'git -C /x push',
    'cd /x && git -c a=b push',
  ]) {
    assert.equal(runsGitPush(command), true, command)
  }
  for (const command of [
    "git commit -m 'git push later'",
    'git status',
    'git pushed',
    'echo git push',
  ]) {
    assert.equal(runsGitPush(command), false, command)
  }
})
