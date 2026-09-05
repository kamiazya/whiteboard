import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveDevPort, isMainCheckout, normalizeRepoRootForHash } from './dev-port-lib.mjs'
// A checkout without with-dev-data-dir-lib.mjs is a stale base: the module
// missing makes this whole suite fail to load, turning a silent stale-base
// bug into a loud one.
import { resolveDevDataDirEnv } from './with-dev-data-dir-lib.mjs'

describe('pre-flight: the dev-data-dir helper the port derivation depends on is present', () => {
  it('resolveDevDataDirEnv is importable', () => {
    expect(typeof resolveDevDataDirEnv).toBe('function')
  })
})

describe('normalizeRepoRootForHash', () => {
  it('strips a trailing separator', () => {
    expect(normalizeRepoRootForHash('/repo/worktree/', 'darwin')).toBe(
      normalizeRepoRootForHash('/repo/worktree', 'darwin'),
    )
  })

  it('lowercases and forward-slashes on win32', () => {
    expect(normalizeRepoRootForHash('C:\\Repo\\Worktree', 'win32')).toBe(
      normalizeRepoRootForHash('c:/repo/worktree', 'win32'),
    )
  })

  it('is case-sensitive on posix platforms', () => {
    expect(normalizeRepoRootForHash('/Repo/Worktree', 'darwin')).not.toBe(
      normalizeRepoRootForHash('/repo/worktree', 'darwin'),
    )
  })
})

describe('deriveDevPort', () => {
  it('is deterministic: same repoRoot derives the same port on repeated calls', () => {
    const a = deriveDevPort({ repoRoot: '/repo/worktrees/foo', isMainCheckout: false, env: {} })
    const b = deriveDevPort({ repoRoot: '/repo/worktrees/foo', isMainCheckout: false, env: {} })

    expect(a).toBe(b)
  })

  it('always derives a port within [3100, 3999] for non-main checkouts', () => {
    const fixtures = [
      '/repo/worktrees/alpha',
      '/repo/worktrees/beta',
      '/Users/dev/whiteboard-2',
      '/home/ci/checkout/pr-1234',
      '/repo/worktrees/dev-port-split',
      '/repo/worktrees/apps-web-slice-b',
      '/repo/worktrees/dev-data-dir',
      '/repo/worktrees/z',
    ]

    for (const repoRoot of fixtures) {
      const port = deriveDevPort({ repoRoot, isMainCheckout: false, env: {} })
      expect(port).toBeGreaterThanOrEqual(3100)
      expect(port).toBeLessThanOrEqual(3999)
    }
  })

  it('returns 3099 for the main checkout regardless of repoRoot', () => {
    const port = deriveDevPort({ repoRoot: '/anything', isMainCheckout: true, env: {} })

    expect(port).toBe(3099)
  })

  it('derives distinct ports for distinct sibling worktree paths', () => {
    const a = deriveDevPort({ repoRoot: '/repo/worktrees/alpha', isMainCheckout: false, env: {} })
    const b = deriveDevPort({ repoRoot: '/repo/worktrees/beta', isMainCheckout: false, env: {} })

    expect(a).not.toBe(b)
  })

  it('WHITEBOARD_DEV_PORT env override wins over derivation, even for the main checkout', () => {
    const port = deriveDevPort({
      repoRoot: '/repo',
      isMainCheckout: true,
      env: { WHITEBOARD_DEV_PORT: '4242' },
    })

    expect(port).toBe(4242)
  })

  it('throws on a non-numeric WHITEBOARD_DEV_PORT override', () => {
    expect(() =>
      deriveDevPort({
        repoRoot: '/repo',
        isMainCheckout: false,
        env: { WHITEBOARD_DEV_PORT: 'nope' },
      }),
    ).toThrow(/WHITEBOARD_DEV_PORT/)
  })

  it('throws on an out-of-range WHITEBOARD_DEV_PORT override', () => {
    expect(() =>
      deriveDevPort({
        repoRoot: '/repo',
        isMainCheckout: false,
        env: { WHITEBOARD_DEV_PORT: '70000' },
      }),
    ).toThrow(/WHITEBOARD_DEV_PORT/)
  })

  it('throws on an empty-string WHITEBOARD_DEV_PORT override', () => {
    expect(() =>
      deriveDevPort({ repoRoot: '/repo', isMainCheckout: false, env: { WHITEBOARD_DEV_PORT: '' } }),
    ).toThrow(/WHITEBOARD_DEV_PORT/)
  })
})

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

  it('falls back to true (main-checkout port 3099) when .git is missing entirely, instead of throwing', () => {
    // A non-git checkout (npm tarball extraction, some sandboxed CI checkouts)
    // has no .git at all. Throwing here would crash dev startup outright;
    // falling back to the main-checkout port is the same safe default
    // deriveDevPort already uses for the ordinary main-checkout case.
    tempRoot = mkdtempSync(join(tmpdir(), 'is-main-checkout-'))

    expect(isMainCheckout(tempRoot)).toBe(true)
  })

  it('resolves relative to the repo root, not the process cwd', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'is-main-checkout-'))
    mkdirSync(join(tempRoot, '.git'))

    expect(isMainCheckout(resolve(tempRoot))).toBe(true)
  })
})
