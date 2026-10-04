#!/usr/bin/env node
// Coverage for hook-command-lib.mjs. Run with: pnpm test:scripts.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { prNumberFromMerge, runsGh, runsGitPush } from './hook-command-lib.mjs'

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
    assert.equal(runsGh(command, 'pr merge'), true, command)
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
    assert.equal(runsGh(command, 'pr merge'), false, command)
  }
  assert.equal(runsGh("git commit -m 'gh pr create later'", 'pr create'), false)
  assert.equal(runsGh('gh pr create --title x', 'pr create'), true)
})

test('the PR number is read from the command only where it is a command', () => {
  assert.equal(prNumberFromMerge('gh pr merge 1751 --squash --delete-branch'), 1751)
  assert.equal(prNumberFromMerge('cd /x && gh pr merge 42 --squash'), 42)
  assert.equal(prNumberFromMerge('gh pr merge --squash'), null)
  assert.equal(prNumberFromMerge('gh pr create --title x'), null)
  assert.equal(prNumberFromMerge("git commit -m 'gh pr merge 9'"), null)
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
