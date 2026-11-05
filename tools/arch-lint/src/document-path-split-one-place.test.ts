/**
 * A document path is split into its folder and its last segment in ONE
 * place, `model`'s `document-path.ts` (`parentOfPath`, `leafOfPath`), and
 * this scan is the executable half of that rule.
 *
 * Why it needs a scan. Every hand copy of the split is one line, so nobody
 * thinks twice before writing another, and the copies did not agree: some
 * answered `''` for a top-level path's folder and one answered `undefined`,
 * so two callers comparing parents compared different things. The spelling
 * every copy shares is `lastIndexOf('/')`, which is what this scan looks for.
 *
 * What it cannot tell is whether the string being split IS a document path —
 * a URL, a scene id and a module specifier split on `/` too. Those are the
 * ledger, each with why, and the ledger is held from both sides: an entry
 * must still hold exactly the count it records, so it can only shrink.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SPLIT = /\.lastIndexOf\(\s*(['"`])\/\1\s*\)/g

/** The module that owns the split. */
const OWNER = 'packages/model/src/document-path.ts'

/**
 * Production source that still spells the split, with how many times and
 * why. Shrink-only: replace a document-path entry with the model helpers and
 * drop it here; the count check fails until you do.
 */
const LEDGER: Readonly<Record<string, { readonly count: number; readonly why: string }>> = {
  'apps/web/src/components/spatial-editor/use-scene-projection.ts': {
    count: 1,
    why: 'splits a scene node id (`<thread>/<part>`), not a document path',
  },
  'packages/mcp-server/src/server/security/route-scope-registry.ts': {
    count: 1,
    why: 'splits an HTTP route path to read its action segment',
  },
}

const files: string[] = []
for (const dir of SCAN_ROOTS) {
  // `tools/*` splits file-system paths and module specifiers, never a document path.
  if (dir.startsWith('tools/')) continue
  walkSourceFiles(join(REPO_ROOT, dir), files)
}
const production = files.filter((path) => !isTestPath(path))
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const countIn = (rel: string): number =>
  [...readFileSync(join(REPO_ROOT, rel), 'utf8').matchAll(SPLIT)].length

describe("a document path is split in one place (model's document-path.ts)", () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(500)
    expect(production.map(relOf)).toContain(OWNER)
  })

  it('the owner still holds the split', () => {
    expect(countIn(OWNER)).toBeGreaterThan(0)
  })

  it("no production source outside the owner and the ledger spells lastIndexOf('/')", () => {
    const hits = production
      .map(relOf)
      .filter((rel) => rel !== OWNER && LEDGER[rel] === undefined)
      .filter((rel) => countIn(rel) > 0)
    expect(
      hits,
      "use parentOfPath / leafOfPath from @kamiazya/whiteboard-model: the parent of a top-level path is '' there, never undefined",
    ).toEqual([])
  })

  it('every ledger entry holds exactly the count it records', () => {
    const drifted = Object.entries(LEDGER)
      .filter(([rel, entry]) => countIn(rel) !== entry.count)
      .map(([rel, entry]) => `${rel}: ledgered ${entry.count}, found ${countIn(rel)}`)
    expect(drifted, 'lower the count (or drop the entry) when a split leaves a file').toEqual([])
  })
})
