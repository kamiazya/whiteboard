import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The property-test prelude (`fc`, `fcTest`, `withDefaults`) was written
// THIRTEEN times, once per package, and the count had grown by four in the
// month before this guard existed. The cost was never the lines: it is that a
// change to the discipline — `numRuns`, a reporter, a `verbose` default — has
// thirteen places to reach, and that the fourteenth package to add a property
// copies whatever its nearest neighbour happened to have.
//
// Measured before the extraction, after normalising whitespace and comments:
// eight copies were byte-identical, two more were identical to each other, and
// three had diverged. The divergence that mattered is invisible in a diff of
// any one file — `apps/web` and `canvas-viewer` had independently made
// `withDefaults` generic so a caller could pass `examples`, and the other
// eleven refused it.
//
// So the rule is: a package's `test-utils/fast-check.ts` re-exports the one in
// `model`, or it is named below with a reason.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Where the prelude actually lives. */
const CANONICAL = 'packages/model/src/test-utils/fast-check.ts'

/**
 * Files that define the prelude themselves. Each says why, because a bare
 * exemption is the duplication with a word in front of it.
 */
const LOCAL_PRELUDES: Record<string, string> = {
  [CANONICAL]: 'the one this rule points every other copy at',
  'packages/history/src/test-utils/fast-check.ts':
    'this package depends on loro-crdt and nothing else, which is the claim package-history.md makes about it; a devDependency on model for three lines would be its first exception',
}

function preludeFiles(): string[] {
  return execFileSync('git', ['ls-files', '*test-utils/fast-check.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
}

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8')

describe('the fast-check prelude is written once', () => {
  it('found the prelude files at all', () => {
    // Without this, a glob that stopped matching would report every package as
    // compliant — the same shape as a clean tree.
    const files = preludeFiles()
    expect(files.length).toBeGreaterThan(5)
    expect(files).toContain(CANONICAL)
  })

  it('has every package re-export the canonical prelude, or say why not', () => {
    const offenders = preludeFiles()
      .filter((path) => !(path in LOCAL_PRELUDES))
      .filter((path) => !read(path).includes("from '@kamiazya/whiteboard-model/test-utils'"))
      .map(
        (path) =>
          `${path}: defines its own prelude — re-export @kamiazya/whiteboard-model/test-utils, or add it to LOCAL_PRELUDES with a reason`,
      )

    expect(offenders).toEqual([])
  })

  it('holds no exemption for a file that is gone or now re-exports', () => {
    const live = new Set(preludeFiles())
    const obsolete = Object.keys(LOCAL_PRELUDES).filter(
      (path) =>
        !live.has(path) ||
        (path !== CANONICAL && read(path).includes("from '@kamiazya/whiteboard-model/test-utils'")),
    )

    expect(obsolete).toEqual([])
  })

  it('keeps every local prelude on the canonical signature', () => {
    // A local copy is allowed to EXIST; it is not allowed to drift. The
    // generic parameter is the thing that actually diverged, so it is the
    // thing compared.
    const signature =
      /export function withDefaults<T = never>\(override\?: fc\.Parameters<T>\): fc\.Parameters<T>/
    const drifted = Object.keys(LOCAL_PRELUDES).filter((path) => !signature.test(read(path)))

    expect(drifted).toEqual([])
  })
})
