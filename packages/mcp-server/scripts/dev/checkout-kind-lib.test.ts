import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isMainCheckout } from './checkout-kind-lib.mjs'

describe('isMainCheckout', () => {
  let tempRoot: string

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  it('returns true when .git is a directory (main checkout)', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'is-main-checkout-'))
    mkdirSync(join(tempRoot, '.git'))

    expect(isMainCheckout(tempRoot)).toBe(true)
  })

  it('returns false when .git is a file (linked worktree)', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'is-main-checkout-'))
    writeFileSync(join(tempRoot, '.git'), 'gitdir: /repo/.git/worktrees/foo\n')

    expect(isMainCheckout(tempRoot)).toBe(false)
  })

  it('falls back to true when .git is missing entirely, instead of throwing', () => {
    // A non-git checkout (npm tarball extraction, some sandboxed CI checkouts)
    // has no .git at all. Throwing here would crash dev tooling outright.
    tempRoot = mkdtempSync(join(tmpdir(), 'is-main-checkout-'))

    expect(isMainCheckout(tempRoot)).toBe(true)
  })

  it('resolves relative to the repo root, not the process cwd', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'is-main-checkout-'))
    mkdirSync(join(tempRoot, '.git'))

    expect(isMainCheckout(resolve(tempRoot))).toBe(true)
  })
})
