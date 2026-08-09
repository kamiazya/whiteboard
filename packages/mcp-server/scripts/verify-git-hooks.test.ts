/**
 * Guards the shape of the INSTALLED git hooks, which is a different question
 * from whether lefthook.yml is correct.
 *
 * A tool that appends its own block to an existing hook file (code-review-graph
 * does this) silently disables every gate lefthook runs: the script's exit
 * status becomes the appended block's, not lefthook's, so a failing secretlint
 * still lets the commit through. That is a gate you believe you have and do
 * not — the worst kind — and nothing else in the repo notices, because
 * lefthook itself reports the failure correctly on its way past.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findCommandsAfterLefthook } from './verify-git-hooks.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '../../../')
const HOOKS_DIR = join(REPO_ROOT, '.git', 'hooks')

const LEFTHOOK_TAIL = `call_lefthook run "pre-commit" "$@"\n`
const LEFTHOOK_SCRIPT = `#!/bin/sh\ncall_lefthook()\n{\n  lefthook "$@"\n}\n\n${LEFTHOOK_TAIL}`

describe('findCommandsAfterLefthook', () => {
  it('accepts a hook that ends with the lefthook invocation', () => {
    expect(findCommandsAfterLefthook(LEFTHOOK_SCRIPT)).toEqual([])
  })

  it('reports commands appended after the lefthook invocation', () => {
    const appended = `${LEFTHOOK_SCRIPT}\n#!/bin/sh\n# Installed by some-tool.\nsome-tool update || true\n`
    expect(findCommandsAfterLefthook(appended)).toEqual(['some-tool update || true'])
  })

  it('ignores comments and blank lines after the invocation, which cannot change the exit status', () => {
    const commented = `${LEFTHOOK_SCRIPT}\n\n# a trailing note\n\n`
    expect(findCommandsAfterLefthook(commented)).toEqual([])
  })

  it('says nothing about a hook lefthook does not manage', () => {
    // Someone else's hook is not this guard's business — only the case where
    // lefthook's exit status is being discarded.
    expect(findCommandsAfterLefthook('#!/bin/sh\necho hi\n')).toEqual([])
  })
})

describe('the hooks installed in this clone', () => {
  const hookFiles = existsSync(HOOKS_DIR)
    ? readdirSync(HOOKS_DIR).filter((name) => !name.endsWith('.sample'))
    : []

  // Skipped rather than failed on a fresh checkout (CI) where no hook has
  // been installed: absence is not the defect this guards.
  it.skipIf(hookFiles.length === 0)(
    'never discard lefthook exit status by appending to its script',
    () => {
      const broken = hookFiles
        .map((name) => ({
          name,
          extra: findCommandsAfterLefthook(readFileSync(join(HOOKS_DIR, name), 'utf8')),
        }))
        .filter((entry) => entry.extra.length > 0)

      expect(
        broken,
        `These hooks run commands after lefthook, so git sees THEIR exit status and every ` +
          `lefthook gate is advisory:\n${broken
            .map((entry) => `  .git/hooks/${entry.name}: ${entry.extra.join(' ; ')}`)
            .join('\n')}\n` +
          `Run 'pnpm verify:git-hooks --fix' to move the appended block ahead of lefthook.`,
      ).toEqual([])
    },
  )
})
