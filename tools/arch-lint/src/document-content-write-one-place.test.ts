/**
 * A keeper writes a document's whole content through loro-adapter's
 * `writeDocumentContentAndName`, never the bare `writeWorkspaceDocumentContent`
 * beneath it, so a note still at a generated path is named after its heading
 * however its body was written. A write that skipped the name kept the old
 * one until the next unrelated keystroke named it, which reads as a rename
 * nobody made.
 *
 * The bare write stays loro-adapter's own: its duplicate and adopt write
 * content under a name the caller supplied, so there is nothing to seed. Tests
 * and `test-utils` seed fixtures with it and are out of scope.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const OWNER = 'packages/loro-adapter/src/'
const BARE_WRITE = ['writeWorkspaceDocumentContent']

/** Shipped callers outside loro-adapter that write without naming on purpose, each with why. */
const LEFT_IN_PLACE: Readonly<Record<string, string>> = {}

const writes = (source: string, fileName = 'fixture.ts'): boolean =>
  countNamedUses(fileName, source, BARE_WRITE) > 0

const files: string[] = []
for (const root of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, root), files)
const production = files
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))
const outside = production.filter(({ rel }) => !rel.startsWith(OWNER))
const writersIn = (scope: typeof production) =>
  scope.filter(({ path }) => writes(readFileSync(path, 'utf8'), path)).map(({ rel }) => rel)

describe("a keeper's whole-content write names the note", () => {
  it('recognises a call however spelled, and not a mention', () => {
    expect(writes('writeWorkspaceDocumentContent(doc, id, source)')).toBe(true)
    expect(
      writes("import { writeWorkspaceDocumentContent as put } from 'x'\nput(doc, id, source)"),
    ).toBe(true)
    expect(writes('// writeWorkspaceDocumentContent(doc, id, source)')).toBe(false)
    expect(writes('writeDocumentContentAndName(doc, id, source)')).toBe(false)
  })

  it('scans a tree that holds the owner and its callers', () => {
    // An empty scan agrees with every rule; the owner's own uses are what keep it honest.
    expect(outside.length).toBeGreaterThan(1000)
    expect(writersIn(production.filter(({ rel }) => rel.startsWith(OWNER)))).toEqual(
      expect.arrayContaining([
        'packages/loro-adapter/src/name-from-title.ts',
        'packages/loro-adapter/src/workspace-duplicate.ts',
      ]),
    )
  })

  it('has no bare write outside loro-adapter', () => {
    const unlisted = writersIn(outside).filter((rel) => LEFT_IN_PLACE[rel] === undefined)
    expect(
      unlisted,
      'write through `writeDocumentContentAndName` so the note is named after its heading',
    ).toEqual([])
  })

  it('every ledgered caller still writes bare', () => {
    const callers = new Set(writersIn(outside))
    const stale = Object.keys(LEFT_IN_PLACE).filter((rel) => !callers.has(rel))
    expect(stale, 'a caller that moved to the naming write no longer needs its entry').toEqual([])
  })
})
