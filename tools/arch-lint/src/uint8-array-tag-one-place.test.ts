/**
 * "Is this a Uint8Array, whichever realm built it" is answered in ONE place,
 * `model`'s `uint8-array.ts`, and this scan is the executable half of that.
 *
 * Why it needs a scan. The tag test was written five ways across the repo,
 * and the copies disagreed in the way that matters: two read only the
 * `Object.prototype.toString` tag, which any plain object can wear through
 * `Symbol.toStringTag`, while the others also required `ArrayBuffer.isView`.
 * A weaker copy still passes every test that builds a real array, so the
 * only thing that can notice it is a rule about where the tag may be spelled.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const TAG = /\[object Uint8Array\]/

/** The one module that spells the tag. Both-sided: it must still contain it. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/model/src/uint8-array.ts': 'the one realm-independent Uint8Array predicate',
}

const files: string[] = []
for (const dir of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, dir), files)
const production = files.filter((path) => !isTestPath(path))
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

describe('the Uint8Array tag test is written in one place', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(500)
  })

  it('no production source outside the allowlist spells the Uint8Array tag', () => {
    const hits = production
      .map(relOf)
      .filter((rel) => ALLOWLIST[rel] === undefined)
      .filter((rel) => TAG.test(readFileSync(join(REPO_ROOT, rel), 'utf8')))
    expect(
      hits,
      'use `isUint8ArrayAnyRealm` / `uint8ArrayAnyRealmSchema` from @kamiazya/whiteboard-model: a tag-only copy accepts any object wearing Symbol.toStringTag',
    ).toEqual([])
  })

  it('every allowlist entry still spells the tag', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (rel) => !TAG.test(readFileSync(join(REPO_ROOT, rel), 'utf8')),
    )
    expect(stale, 'an entry that outlives its tag is how an allowlist stops being read').toEqual([])
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(1)
  })
})
