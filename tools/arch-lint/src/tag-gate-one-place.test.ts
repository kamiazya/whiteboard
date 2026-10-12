/**
 * When a render reads the workspace's tag library is decided in ONE place,
 * `drawsATag` in server-core's `tag-library.ts`, and this scan is the
 * executable half of that.
 *
 * The rule — read the library only when something the render DRAWS carries a
 * tag, the canvases it draws itself and every canvas its reference graph
 * loaded — was once written out at each renderer: the same flatten of the
 * graph, the same `.some(carriesATag)`, the same read. A copy that is
 * extended (to lines, to a markdown body's embeds) while another is not
 * makes two tools colour the same board differently, and each copy still
 * passes its own tests. So the per-canvas predicate may be named only beside
 * the rule that composes it.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const PREDICATE = /\bcarriesATag\b/

/** The one module that names the per-canvas predicate. Both-sided: it must still name it. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/server-core/src/tools/tag-library.ts':
    'the per-canvas predicate and `drawsATag`, the one rule composed from it',
}

const files: string[] = []
for (const dir of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, dir), files)
const production = files.filter((path) => !isTestPath(path))
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

describe('the tag-library gate is written in one place', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(500)
  })

  it('no production source outside the allowlist names the per-canvas tag predicate', () => {
    const hits = production
      .map(relOf)
      .filter((rel) => ALLOWLIST[rel] === undefined)
      .filter((rel) => PREDICATE.test(readFileSync(join(REPO_ROOT, rel), 'utf8')))
    expect(
      hits,
      'gate a render on `drawsATag` / `taggedDrawingLibrary` from server-core: a second copy of the rule is a second answer to which boards get coloured',
    ).toEqual([])
  })

  it('every allowlist entry still names the predicate', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (rel) => !PREDICATE.test(readFileSync(join(REPO_ROOT, rel), 'utf8')),
    )
    expect(
      stale,
      'an entry that outlives its predicate is how an allowlist stops being read',
    ).toEqual([])
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(1)
  })
})
