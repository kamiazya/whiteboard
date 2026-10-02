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
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../src/shared/test-utils/repo-root.js'
import { findCommandsAfterLefthook, gitHooksDir } from './verify-git-hooks.mjs'

const REPO_ROOT = repoRoot()
// Asked of git: `.git` is a file in a linked worktree, so joining it by hand
// answered "no hooks" in every worktree and the guard below skipped there.
const HOOKS_DIR = gitHooksDir(REPO_ROOT)

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

describe('gitHooksDir', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      encoding: 'utf8',
    })

  it('answers the shared hooks directory from inside a linked worktree, where .git is a file', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-hooks-dir-')))
    try {
      const main = join(base, 'main')
      mkdirSync(main)
      git(main, 'init', '-q')
      git(main, 'commit', '-q', '--allow-empty', '-m', 'seed')
      const linked = join(base, 'linked')
      git(main, 'worktree', 'add', '-q', linked)
      expect(gitHooksDir(linked)).toBe(join(main, '.git', 'hooks'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('follows core.hooksPath, which moves the hooks anywhere', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-hooks-path-')))
    try {
      git(base, 'init', '-q')
      git(base, 'config', 'core.hooksPath', join(base, 'elsewhere'))
      expect(gitHooksDir(base)).toBe(join(base, 'elsewhere'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('finds a directory for this checkout, whichever kind it is', () => {
    expect(isAbsolute(HOOKS_DIR)).toBe(true)
  })
})

describe('the hooks installed in this clone', () => {
  const hookFiles = existsSync(HOOKS_DIR)
    ? readdirSync(HOOKS_DIR).filter((name) => !name.endsWith('.sample'))
    : []

  // Skipped rather than failed where git's own hooks directory holds no
  // hook: nothing is installed, so nothing can have been appended to.
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
            .map((entry) => `  ${join(HOOKS_DIR, entry.name)}: ${entry.extra.join(' ; ')}`)
            .join('\n')}\n` +
          `Run 'pnpm verify:git-hooks --fix' to move the appended block ahead of lefthook.`,
      ).toEqual([])
    },
  )
})
