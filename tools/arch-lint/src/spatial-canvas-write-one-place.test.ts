/**
 * The whole-canvas resync is the loro-adapter's own mechanic, and nothing
 * outside it calls it.
 *
 * `writeSpatialCanvas` / `writeSpatialCanvasInto` set every incoming record
 * and DELETE every stored id the incoming canvas lacks. A caller's canvas
 * comes from `readSpatialCanvas`, which omits any record this build's schema
 * cannot read, so that deletion erases a newer client's records — and a CRDT
 * delete ships to the keeper and every replica. A caller that edits a canvas
 * it read applies `reconcileSpatialCanvas(doc, prev, next)`, which deletes
 * only what `prev` held. The browser editor's save fallback and its
 * proposal-adopt arm both called the resync until they were moved over.
 *
 * Tests and `test-utils` seed documents with it on purpose, so they are out
 * of scope; so is `packages/loro-adapter/src`, which owns the mechanic and
 * uses it for a document it has just created.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const OWNER = 'packages/loro-adapter/src/'
const CALL = /\bwriteSpatialCanvas(?:Into)?\s*\(/

const files: string[] = []
for (const root of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, root), files)
const production = files
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))
  .filter(({ rel }) => !rel.startsWith(OWNER))

const FIXTURES: readonly { readonly source: string; readonly calls: boolean }[] = [
  { source: 'writeSpatialCanvas(doc, next)', calls: true },
  { source: 'writeSpatialCanvasInto(doc, next)', calls: true },
  { source: 'writer.writeSpatialCanvas (next)', calls: true },
  { source: 'import { writeSpatialCanvas } from "x"', calls: false },
  { source: '// writeSpatialCanvas(doc, next) is the resync', calls: false },
  { source: "log.warn('writeSpatialCanvas(doc, next)')", calls: false },
  { source: 'reconcileSpatialCanvas(doc, prev, next)', calls: false },
]

describe('the whole-canvas resync stays inside loro-adapter', () => {
  it('recognises a call in every spelling, and not a mention', () => {
    for (const { source, calls } of FIXTURES) {
      expect(CALL.test(stripCommentsAndStrings(source)), source).toBe(calls)
    }
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(1000)
    expect(production.some(({ rel }) => rel === 'apps/web/src/lib/command-writes.ts')).toBe(true)
  })

  it('has no caller in a composition root or another package', () => {
    const callers = production
      .filter(({ path }) => CALL.test(stripCommentsAndStrings(readFileSync(path, 'utf8'))))
      .map(({ rel }) => rel)
    expect(
      callers,
      'apply an edit to a canvas you read with `reconcileSpatialCanvas(doc, prev, next)` from loro-adapter, so a record this build cannot read is not deleted',
    ).toEqual([])
  })
})
