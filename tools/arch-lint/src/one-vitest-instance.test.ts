// The tree must resolve ONE vitest runtime, because `@fast-check/vitest`
// binds to whichever vitest it was installed beside and reports "failed to
// find the current suite" when the test file runs under another.
//
// `@types/node` is an optional peer of `vitest` and `vite`, so two versions of
// it (two workspaces whose `^24` ranges were locked on different days) split
// each into two snapshot keys. They are two store entries for one version,
// hence two module instances: the root run (one instance) passes while a run
// from inside a package (the other) fails every fast-check file. The install
// is frozen-lockfile clean either way, so only the lockfile can say so —
// `pnpm dedupe` is the repair and the catalog entry is what keeps it so.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const lockfile = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf-8')
const workspaceYaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf-8')

/** The `snapshots:` section — one key per distinct resolved peer set. */
const snapshots = lockfile.slice(lockfile.indexOf('\nsnapshots:\n'))

/** Every snapshot key (a two-space-indented top-level entry) for `name`@`major`. */
function snapshotKeys(name: string, majorPrefix: string): string[] {
  const entry = new RegExp(`^ {2}'?(${name}@${majorPrefix}[^\\n]*?)'?:$`, 'gm')
  return [...snapshots.matchAll(entry)].map((m) => m[1] as string)
}

describe('the lockfile resolves one vitest runtime', () => {
  it('reads a snapshots section that actually holds the packages', () => {
    // A slice or a regex that stops matching reports "exactly one" for
    // everything, which is the answer this file exists to distrust.
    expect(snapshots.startsWith('\nsnapshots:\n')).toBe(true)
    expect(snapshotKeys('vitest', '5').length).toBeGreaterThan(0)
    expect(snapshotKeys('vite', '8').length).toBeGreaterThan(0)
  })

  it('has exactly one vitest snapshot key', () => {
    expect(snapshotKeys('vitest', '5')).toHaveLength(1)
  })

  it('has exactly one vite snapshot key', () => {
    expect(snapshotKeys('vite', '8')).toHaveLength(1)
  })

  it('resolves exactly one @types/node', () => {
    const versions = new Set(
      [...snapshots.matchAll(/^ {2}'?@types\/node@([0-9][^'":]*)'?:$/gm)].map((m) => m[1]),
    )
    expect([...versions]).toHaveLength(1)
  })

  it('pins @types/node in the catalog so every workspace takes the same range', () => {
    expect(workspaceYaml).toMatch(/^ {2}"@types\/node": /m)
  })
})
