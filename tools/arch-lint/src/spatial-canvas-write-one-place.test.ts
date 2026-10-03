/**
 * The whole-canvas resync is the loro-adapter's own mechanic, and nothing
 * outside it calls it. The same goes for the three envelope resyncs.
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
 * `writeFacets`, `writeCoreFacets` and `writeTrustFacets` are that mechanic for
 * the envelope's three buckets: each deletes every stored key the caller did
 * not name, and each reader drops what it cannot parse. An edit that started
 * from a read applies `reconcileFacets` / `reconcileCoreFacets` (or the canvas
 * reconcile, which owns the canvas's facets) instead. `wb_workspace_edit`'s
 * `document.set` is the one caller that states a whole document on purpose.
 *
 * Tests and `test-utils` seed documents with it on purpose, so they are out
 * of scope; so is `packages/loro-adapter/src`, which owns the mechanic and
 * uses it for a document it has just created.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const OWNER = 'packages/loro-adapter/src/'
const WRITE_NAMES = ['writeSpatialCanvas', 'writeSpatialCanvasInto']
const ENVELOPE_NAMES = ['writeFacets', 'writeCoreFacets', 'writeTrustFacets']

/** Uses of a name however spelled: bare, qualified, bracketed or through an aliased import. */
const usesAny = (names: readonly string[], source: string, fileName = 'fixture.ts'): boolean =>
  countNamedUses(fileName, source, names) > 0

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
  { source: 'import { writeSpatialCanvas as save } from "x"\nsave(doc, next)', calls: true },
  { source: "bridge['writeSpatialCanvasInto'](doc, next)", calls: true },
  { source: 'import { writeSpatialCanvas } from "x"', calls: false },
  { source: '// writeSpatialCanvas(doc, next) is the resync', calls: false },
  { source: "log.warn('writeSpatialCanvas(doc, next)')", calls: false },
  { source: 'reconcileSpatialCanvas(doc, prev, next)', calls: false },
]

describe('the whole-canvas resync stays inside loro-adapter', () => {
  it('recognises a call in every spelling, and not a mention', () => {
    for (const { source, calls } of FIXTURES) {
      expect(usesAny(WRITE_NAMES, source), source).toBe(calls)
    }
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(1000)
    expect(production.some(({ rel }) => rel === 'apps/web/src/lib/command-writes.ts')).toBe(true)
  })

  it('has no caller in a composition root or another package', () => {
    const callers = production
      .filter(({ path }) => usesAny(WRITE_NAMES, readFileSync(path, 'utf8'), path))
      .map(({ rel }) => rel)
    expect(
      callers,
      'apply an edit to a canvas you read with `reconcileSpatialCanvas(doc, prev, next)` from loro-adapter, so a record this build cannot read is not deleted',
    ).toEqual([])
  })
})

/** The one production file that replaces a document's envelope wholesale. */
const ENVELOPE_REPLACERS = ['packages/server-core/src/tools/document-set.ts']

const ENVELOPE_FIXTURES: readonly { readonly source: string; readonly calls: boolean }[] = [
  { source: 'writeFacets(doc, facets)', calls: true },
  { source: 'writeCoreFacets(doc, meta)', calls: true },
  { source: 'writeTrustFacets (doc, trust)', calls: true },
  { source: 'import { writeFacets as put } from "x"\nput(doc, facets)', calls: true },
  { source: "bridge['writeCoreFacets'](doc, meta)", calls: true },
  { source: 'import { writeFacets } from "x"', calls: false },
  { source: '// writeCoreFacets(doc, meta) replaces the bucket', calls: false },
  { source: 'reconcileFacets(doc, prev, next)', calls: false },
  { source: 'reconcileCoreFacets(doc, prev, next)', calls: false },
]

describe('the envelope resyncs stay inside loro-adapter and document.set', () => {
  const callsEnvelope = (path: string): boolean =>
    usesAny(ENVELOPE_NAMES, readFileSync(path, 'utf8'), path)

  it('recognises a call in every spelling, and not a mention', () => {
    for (const { source, calls } of ENVELOPE_FIXTURES) {
      expect(usesAny(ENVELOPE_NAMES, source), source).toBe(calls)
    }
  })

  it('has no caller beyond the wholesale replacers', () => {
    const callers = production
      .filter(({ path }) => callsEnvelope(path))
      .map(({ rel }) => rel)
      .filter((rel) => !ENVELOPE_REPLACERS.includes(rel))
    expect(
      callers,
      'apply an edit to an envelope you read with `reconcileFacets` / `reconcileCoreFacets` from loro-adapter, so an entry this build cannot read is not deleted',
    ).toEqual([])
  })

  it('lists only replacers that still call one', () => {
    // An entry that no longer calls a resync is a standing permission for the
    // next caller, and nothing else would notice it had outlived its reason.
    for (const rel of ENVELOPE_REPLACERS) {
      const entry = production.find((file) => file.rel === rel)
      expect(entry, `${rel} is not a scanned production file`).toBeDefined()
      expect(callsEnvelope(entry?.path ?? ''), `${rel} no longer calls a resync`).toBe(true)
    }
  })
})
