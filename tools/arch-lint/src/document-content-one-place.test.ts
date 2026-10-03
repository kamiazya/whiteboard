/**
 * Which half of a document to read, and what a document that names no kind
 * is, are decided in ONE place: loro-adapter's `readDocumentContent`.
 *
 * Five loaders wrote that decision out by hand and disagreed about the
 * default — the daemon read a kind-less document as a canvas while the
 * browser's replica and embed loaders read the same one as prose, so a
 * pre-kind diagram replicated into the browser was drawn as markdown. A
 * kind-less document is spatial (`readDocumentContent` says why).
 *
 * The scan flags a production file outside loro-adapter that calls BOTH
 * `readSpatialCanvas` and `readMarkdownBody`, because choosing between the two
 * is what a hand-written switch does. It cannot see a switch that reads one
 * half and builds the other another way, and it does not judge the default —
 * it keeps a new loader from being the sixth way.
 *
 * Reading both halves is sometimes right, and the ledger says which and why.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const OWNER = 'packages/loro-adapter/src/'
const READS_CANVAS = /\breadSpatialCanvas(?:WithSkipped)?\s*\(/
const READS_BODY = /\breadMarkdownBody\s*\(/

const READS_BOTH: Readonly<Record<string, string>> = {
  'apps/web/src/lib/read-loaded-file-document.ts':
    'reads every half of one load for the embed seam, which picks the half from the workspace listing afterwards',
  'packages/server-core/src/tools/document-set.ts':
    'a write path: it reads the canvas to refuse overwriting a diagram and the body to compare, not to present either',
  'apps/web/src/lib/document-sync-session.ts':
    'the editing session reads the half its own kind has open; it does not choose a kind for a document it did not open',
}

const files: string[] = []
for (const root of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, root), files)
const production = files
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))
  .filter(({ rel }) => !rel.startsWith(OWNER))

function readsBoth(source: string, fileName?: string): boolean {
  const code = stripCommentsAndStrings(source, fileName)
  return READS_CANVAS.test(code) && READS_BODY.test(code)
}

const FIXTURES: readonly { readonly source: string; readonly both: boolean }[] = [
  { source: 'readSpatialCanvas(doc); readMarkdownBody(doc)', both: true },
  { source: 'readSpatialCanvasWithSkipped (doc)\nreadMarkdownBody (doc)', both: true },
  { source: 'readSpatialCanvas(doc)', both: false },
  { source: 'readMarkdownBody(doc)', both: false },
  { source: 'import { readSpatialCanvas, readMarkdownBody } from "x"', both: false },
  { source: '// readSpatialCanvas(doc) then readMarkdownBody(doc)', both: false },
  { source: 'readDocumentContent(doc, kind)', both: false },
]

describe('a document is read by kind in one place', () => {
  it('recognises a file that reads both halves, and not a mention', () => {
    for (const { source, both } of FIXTURES) {
      expect(readsBoth(source), source).toBe(both)
    }
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(1000)
    expect(production.some(({ rel }) => rel === 'apps/web/src/lib/replica-record.ts')).toBe(true)
  })

  it('has no file outside the ledger that reads both halves', () => {
    const readers = production
      .filter(({ path }) => readsBoth(readFileSync(path, 'utf8'), path))
      .map(({ rel }) => rel)
    const unledgered = readers.filter((rel) => !(rel in READS_BOTH))
    expect(
      unledgered,
      'choose the half with `readDocumentContent(doc, entryKind)` from loro-adapter, so a kind-less document reads the same way everywhere; if reading both is the point, ledger the file with the reason',
    ).toEqual([])
    // Parses every production file, which a loaded machine stretches past the default.
  }, 180_000)

  it('keeps no ledger entry for a file that stopped reading both', () => {
    const stale = Object.keys(READS_BOTH).filter((rel) => {
      const hit = production.find((file) => file.rel === rel)
      return hit === undefined || !readsBoth(readFileSync(hit.path, 'utf8'), hit.path)
    })
    expect(stale, 'delete the entry; the file no longer reads both halves').toEqual([])
    expect(Object.keys(READS_BOTH)).toHaveLength(3)
  })
})
