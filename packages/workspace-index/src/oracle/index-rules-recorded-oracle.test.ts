import { readFileSync } from 'node:fs'
import { type CrdtEngine, loadCrdtEngine } from '@kamiazya/whiteboard-loro-adapter'
import { beforeAll, describe, expect, it } from 'vitest'
import { LoroWorkspaceDocumentIndex } from '../loro-workspace-document-index.js'
import {
  type Answer,
  blobSummary,
  type IndexRow,
  replayIndex,
  replayPure,
} from '../test-utils/index-oracle.js'

/**
 * The committed recording of what the workspace index's rules answer under
 * loro-crdt 1.17.1, taken by `scripts/record-index-oracle.ts`. A pure row is a
 * rule over plain values; an index row is one operation over a workspace record
 * (its snapshot and blobs before, the call, the answer or the class of its
 * refusal, and what the keeper stored after). The Rust
 * `whiteboard-workspace-index` crate replays it.
 */
const FILE = new URL('./index-rules.jsonl', import.meta.url)

const HOW_TO_RERECORD =
  'If the change is deliberate, re-record: pnpm --filter @kamiazya/whiteboard-mcp exec tsx ../workspace-index/scripts/record-index-oracle.ts'

type Row = ({ id: string; tag: string; result: Answer } & Partial<IndexRow>) & {
  saves?: number
  deep?: unknown
  vv?: unknown
  blobsAfter?: string[]
} & Record<string, unknown>

const rows: Row[] = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Row)

const PURE_OPS = new Set([
  'firstFreeSegment',
  'moveCollision',
  'sameDisplayName',
  'refuseSiblingDocumentName',
  'refuseMovedName',
  'distinctUnnamedPath',
  'isNamedByAnotherRow',
  'entryOf',
  'restorableTrashDocuments',
])

/** Rows each judgement must hold; `refusing` counts the rows that answer with a refusal. */
const FLOORS: Record<string, { rows: number; refusing: number }> = {
  firstFreeSegment: { rows: 60, refusing: 0 },
  moveCollision: { rows: 50, refusing: 0 },
  sameDisplayName: { rows: 100, refusing: 0 },
  refuseSiblingDocumentName: { rows: 80, refusing: 20 },
  refuseMovedName: { rows: 50, refusing: 1 },
  distinctUnnamedPath: { rows: 40, refusing: 0 },
  isNamedByAnotherRow: { rows: 6, refusing: 0 },
  entryOf: { rows: 60, refusing: 0 },
  restorableTrashDocuments: { rows: 80, refusing: 2 },
  createDocument: { rows: 70, refusing: 30 },
  duplicateDocument: { rows: 20, refusing: 8 },
  resolveDocument: { rows: 20, refusing: 3 },
  resolveDocumentById: { rows: 16, refusing: 0 },
  listDocuments: { rows: 8, refusing: 1 },
  moveDocument: { rows: 50, refusing: 30 },
  setDocumentName: { rows: 50, refusing: 10 },
  listPinnedDocuments: { rows: 8, refusing: 0 },
  setDocumentPinned: { rows: 20, refusing: 4 },
  listFolderNames: { rows: 8, refusing: 0 },
  setFolderName: { rows: 24, refusing: 4 },
  deleteDocument: { rows: 24, refusing: 8 },
  listTrash: { rows: 16, refusing: 0 },
  restoreDocument: { rows: 40, refusing: 4 },
  purgeTrashEntry: { rows: 20, refusing: 0 },
}

/** Public operations of the index that are not recorded, and why. */
const NOT_RECORDED: Record<string, string> = {
  createWorkspace:
    'a registry-free write of an empty record: its only judgement is the input schema, which the port contract suite holds',
  listWorkspaces:
    'answers the registry the composition root supplies, parsed through a read schema',
  resolveWorkspace: 'answers the registry the composition root supplies',
  renameWorkspace: 'answers the registry the composition root supplies, after parsing the input',
}

describe('the recorded workspace index oracle', () => {
  it('holds every judgement at its floor', () => {
    const byOp = new Map<string, Row[]>()
    for (const row of rows) byOp.set(row.op as string, [...(byOp.get(row.op as string) ?? []), row])
    for (const [op, floor] of Object.entries(FLOORS)) {
      const held = byOp.get(op) ?? []
      expect(held.length, `rows of ${op}`).toBeGreaterThanOrEqual(floor.rows)
      expect(
        held.filter((r) => 'err' in r.result).length,
        `refused rows of ${op}`,
      ).toBeGreaterThanOrEqual(floor.refusing)
    }
    expect(
      [...byOp.keys()].filter((op) => !(op in FLOORS)),
      'rows of a judgement with no floor',
    ).toEqual([])
    expect(rows.length, 'recorded rows').toBeGreaterThan(1000)
  })

  it('classifies every operation the index class publishes', () => {
    const published = Object.getOwnPropertyNames(LoroWorkspaceDocumentIndex.prototype).filter(
      (name) => name !== 'constructor',
    )
    expect(published.length, 'operations found').toBeGreaterThan(15)
    const recorded = new Set(Object.keys(FLOORS))
    expect(
      published.filter((name) => !recorded.has(name) && !(name in NOT_RECORDED)),
      'operations neither recorded nor classified',
    ).toEqual([])
    expect(
      Object.keys(NOT_RECORDED).filter((name) => !published.includes(name) || recorded.has(name)),
      'classified operations that are gone or are recorded after all',
    ).toEqual([])
  })

  it('reaches contested paths, shadowed entries, minted ids, restores and shared blobs', () => {
    const text = (row: Row) => JSON.stringify(row.result)
    expect(
      rows.filter((r) => text(r).includes('DocumentPathContestedError')).length,
      'refusals over a contested path',
    ).toBeGreaterThan(4)
    expect(
      rows.filter((r) => text(r).includes('"shadowed":true')).length,
      'shadowed',
    ).toBeGreaterThan(10)
    expect(
      rows.filter((r) => (r.mint?.length ?? 0) > 0 && 'ok' in r.result).length,
      'writes that mint an id',
    ).toBeGreaterThan(30)
    expect(
      rows.filter((r) => r.op === 'restoreDocument' && 'ok' in r.result && r.result.ok !== null)
        .length,
      'restores that place a document',
    ).toBeGreaterThan(10)
    expect(
      rows.filter((r) => r.op === 'moveCollision' && 'ok' in r.result && r.result.ok !== null)
        .length,
      'moves that collide',
    ).toBeGreaterThan(10)
    expect(
      rows.filter((r) => r.tag.startsWith('shared-')).length,
      'rows over a blob two trash rows name',
    ).toBeGreaterThan(8)
    expect(
      rows.filter((r) => /[\u{10000}-\u{10ffff}]/u.test(JSON.stringify(r.nodes ?? r.args))).length,
      'rows holding a surrogate pair',
    ).toBeGreaterThan(20)
  })

  // Goes when the TypeScript index goes: the Rust crate replays the recording
  // against its own answers instead.
  describe('equals what the TypeScript index rules answer today (deleted with the TS)', () => {
    let engine: CrdtEngine
    beforeAll(async () => {
      engine = await loadCrdtEngine()
    })

    it.each(rows.map((row) => [row.id, row] as const))('%s', async (_id, row) => {
      if (PURE_OPS.has(row.op as string)) {
        const result = await replayPure(row as never)
        expect(result, `${row.id} ${row.tag}: result. ${HOW_TO_RERECORD}`).toEqual(row.result)
        return
      }
      const outcome = await replayIndex(row as unknown as IndexRow, engine)
      const why = `${row.id} ${row.tag}. ${HOW_TO_RERECORD}`
      expect(outcome.result, `${why}: result`).toEqual(row.result)
      expect(outcome.minted, `${why}: ids minted`).toBe(row.mint?.length)
      expect(outcome.saves, `${why}: saves`).toBe(row.saves)
      expect(outcome.vv, `${why}: version vector`).toEqual(row.vv)
      if (row.deep !== undefined) expect(outcome.deep, `${why}: stored record`).toEqual(row.deep)
      expect(blobSummary(outcome.blobs), `${why}: blobs left`).toEqual(row.blobsAfter)
    })
  })
})
