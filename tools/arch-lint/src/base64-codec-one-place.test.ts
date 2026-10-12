/**
 * Base64 is encoded and decoded in ONE place, `model`'s `encoding/base64.ts`,
 * and this scan is the executable half of that rule.
 *
 * Why it needs a scan. A hand-rolled codec over `btoa`/`atob` works on every
 * input a test builds and disagrees with the shared one only at the edges:
 * `atob` is forgiving (it strips whitespace and throws on what it refuses),
 * and a bare `String.fromCharCode(...bytes)` overflows the argument list on a
 * picture of megabytes. Each copy chose its own answer, so the only thing
 * that can notice a new one is a rule about where the two globals are called.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const CALL = /\b(?:btoa|atob)\s*\(/

/** The one module that calls them. Both-sided: it must still do so. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/model/src/encoding/base64.ts': 'the one base64 / base64url codec',
}

const files: string[] = []
for (const dir of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, dir), files)
const production = files.filter((path) => !isTestPath(path))
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

describe('base64 is encoded and decoded in one place', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(500)
  })

  it('no production source outside the allowlist calls btoa or atob', () => {
    const hits = production
      .map(relOf)
      .filter((rel) => ALLOWLIST[rel] === undefined)
      .filter((rel) => CALL.test(readFileSync(join(REPO_ROOT, rel), 'utf8')))
    expect(
      hits,
      'use bytesToBase64 / base64ToBytes (or the url variants) from @kamiazya/whiteboard-model: its decoders answer null for text that is not base64 instead of throwing',
    ).toEqual([])
  })

  it('every allowlist entry still calls them', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (rel) => !CALL.test(readFileSync(join(REPO_ROOT, rel), 'utf8')),
    )
    expect(stale, 'an entry that outlives its call is how an allowlist stops being read').toEqual(
      [],
    )
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(1)
  })
})
