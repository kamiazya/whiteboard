import { readFileSync } from 'node:fs'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { CONTENT_CONTAINER_KEYS } from '../loro-bridge.js'
import {
  frontierPairs,
  rootDocumentReaders,
  type VersionPairs,
  versionOfPairs,
  versionPairs,
  workspaceReaders,
} from '../test-utils/crdt-read-oracle.js'
import { WORKSPACE_TREE_KEY } from '../workspace-tree.js'

/**
 * The committed recording of what loro-crdt 1.17.1 and this package's readers
 * answer for every stored shape the loro cohort writes, taken by
 * `scripts/record-crdt-read-oracle.ts`. The Rust `whiteboard-crdt` crate
 * replays it. It holds the bytes as well as the answers, so this test needs no
 * generator.
 */
const FILE = new URL('./crdt-read.jsonl', import.meta.url)

type Export = 'snapshot' | 'updates' | 'shallow'

interface Row {
  id: string
  shape: string
  host: 'workspace' | 'document'
  since: VersionPairs
  snapshot: string
  updates: string
  shallow: string
  /** `null` where an export's import answers as the update import does. */
  deep: { updates: Record<string, unknown> } & Record<
    Exclude<Export, 'updates'>,
    Record<string, unknown> | null
  >
  ids: unknown
  vv: VersionPairs
  frontiers: Array<[string, number]>
  readers: unknown
}

const rows: Row[] = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Row)

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const imported = (b64: string) => {
  const doc = new LoroDoc()
  doc.import(bytes(b64))
  return doc
}

/** Every shape the recording must hold, with the fewest rows that count as holding it. */
const SHAPE_FLOORS: Record<string, number> = {
  'doc-empty': 1,
  'doc-spatial': 20,
  'doc-spatial-locked': 5,
  'doc-markdown': 20,
  'doc-markdown-utf16': 10,
  'doc-envelope': 10,
  'doc-threads': 15,
  'doc-proposals': 10,
  'doc-concurrent': 15,
  'doc-deleted': 10,
  'doc-retired': 5,
  'ws-empty': 1,
  'ws-tree': 15,
  'ws-deep': 3,
  'ws-deleted': 10,
  'ws-folder-names': 5,
  'ws-meta-pins': 5,
  'ws-trash': 5,
  'ws-hosted-content': 15,
  'ws-concurrent': 15,
  'ws-unreadable': 3,
  'ws-random': 30,
}

/** An astral character: two UTF-16 code units, which is where a splice offset goes wrong. */
const hasSurrogatePair = (text: string) => /[\u{10000}-\u{10ffff}]/u.test(text)

describe('the recorded CRDT read oracle', () => {
  it('holds every stored shape at its floor', () => {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.shape, (counts.get(row.shape) ?? 0) + 1)
    for (const [shape, floor] of Object.entries(SHAPE_FLOORS)) {
      expect(counts.get(shape) ?? 0, `rows of shape ${shape}`).toBeGreaterThanOrEqual(floor)
    }
    expect(
      [...counts.keys()].filter((s) => !(s in SHAPE_FLOORS)),
      'shapes with no floor',
    ).toEqual([])
    expect(rows.length, 'recorded rows').toBeGreaterThan(300)
  })

  it('reaches every content root, the workspace roots and the arrangements', () => {
    const populated = (key: string, host: Row['host']) =>
      rows.filter((row) => {
        if (row.host !== host) return false
        const value = row.deep.updates[key]
        if (typeof value === 'string') return value.length > 0
        return typeof value === 'object' && value !== null && Object.keys(value).length > 0
      }).length
    for (const { key } of CONTENT_CONTAINER_KEYS) {
      expect(populated(key, 'document'), `document rows with a populated ${key}`).toBeGreaterThan(2)
    }
    for (const key of ['workspaceMeta', 'trash']) {
      expect(populated(key, 'workspace'), `workspace rows with ${key}`).toBeGreaterThan(2)
    }
    expect(
      rows.filter(
        (r) =>
          r.host === 'workspace' && JSON.stringify(r.deep.updates[WORKSPACE_TREE_KEY]) !== '[]',
      ).length,
      'workspace rows with a populated tree',
    ).toBeGreaterThan(50)
    expect(
      rows.filter((r) => hasSurrogatePair(JSON.stringify(r.deep.updates))).length,
      'rows holding a surrogate pair',
    ).toBeGreaterThan(10)
    expect(
      rows.filter((r) => r.vv.length >= 2).length,
      'rows merged from two or more peers',
    ).toBeGreaterThan(30)
    expect(
      rows.filter((r) => r.shape.endsWith('deleted') || r.shape === 'ws-trash').length,
      'rows holding a deleted item',
    ).toBeGreaterThan(15)
  })

  // Goes when the TypeScript readers go: the Rust crate replays the recording
  // against its own answers instead.
  describe('equals what npm loro-crdt and the TypeScript readers answer today (deleted with the TS)', () => {
    it.each(rows.map((row) => [row.id, row] as const))('%s', async (_id, row) => {
      for (const file of ['snapshot', 'updates'] as const) {
        const doc = imported(row[file])
        expect(doc.toJSON(), `${file} deep value`).toEqual(row.deep[file] ?? row.deep.updates)
        if (file === 'updates') {
          expect(doc.getDeepValueWithID(), 'container ids').toEqual(row.ids)
        }
        expect(versionPairs(doc.oplogVersion()), `${file} version vector`).toEqual(row.vv)
        expect(frontierPairs(doc.frontiers()), `${file} frontiers`).toEqual(row.frontiers)
        const readers =
          row.host === 'workspace'
            ? await workspaceReaders(doc, versionOfPairs(row.since))
            : rootDocumentReaders(doc)
        expect(JSON.parse(JSON.stringify(readers)), `${file} readers`).toEqual(row.readers)
      }
      const shallow = imported(row.shallow)
      expect(shallow.toJSON(), 'shallow deep value').toEqual(row.deep.shallow ?? row.deep.updates)
      expect(frontierPairs(shallow.frontiers()), 'shallow frontiers').toEqual(row.frontiers)
    })
  })
})
