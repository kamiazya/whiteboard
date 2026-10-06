// Run with: node --test .claude/workflows/lib/worktree-cwd.test.mjs
// The workflow sandbox has no import, so dev-loop and review each carry an inline copy of the
// function that tells an agent how to work in a worktree. This test runs both inline copies
// against the module and pins what the module says, so a copy cannot drift and the
// instruction cannot lose the part that keeps a lane's commands in its own worktree.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { worktreeCwdHint, worktreeCwdNote } from './worktree-cwd.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const WORKTREE = '/repo/.claude/worktrees/lane-a'

function extractInline(workflowFile, name) {
  const source = readFileSync(path.join(here, '..', workflowFile), 'utf8')
  const match = source.match(new RegExp(`\\nfunction ${name}\\(cwd\\) \\{[\\s\\S]*?\\n\\}\\n`))
  assert.ok(match, `could not locate \`function ${name}(cwd) {...}\` in ${workflowFile}`)
  // Evaluating a plain function declaration extracted from our own source, not untrusted input
  return new Function(`${match[0]}\nreturn ${name}`)()
}

// A command run from the main checkout with a relative path runs THAT checkout's copy of the
// file and reports green on code the lane never changed; only `cd <worktree> && …` prevents it.
for (const [name, fn] of [
  ['worktreeCwdNote', worktreeCwdNote],
  ['worktreeCwdHint', worktreeCwdHint],
]) {
  test(`${name} tells an agent to run git and every command from the worktree`, () => {
    const said = fn(WORKTREE)
    assert.ok(said.includes(`git -C ${WORKTREE}`), said)
    assert.ok(said.includes(`cd ${WORKTREE} && `), said)
    assert.match(said, /pnpm\/vitest\/node/)
  })

  test(`${name} says nothing when there is no worktree`, () => {
    assert.equal(fn(null), '')
  })
}

for (const [workflowFile, name, fn] of [
  ['dev-loop.workflow.mjs', 'worktreeCwdNote', worktreeCwdNote],
  ['review.workflow.mjs', 'worktreeCwdHint', worktreeCwdHint],
]) {
  test(`${workflowFile}'s inline ${name} says what the module says`, () => {
    const inline = extractInline(workflowFile, name)
    assert.equal(inline(WORKTREE), fn(WORKTREE))
    assert.equal(inline(null), fn(null))
  })
}
