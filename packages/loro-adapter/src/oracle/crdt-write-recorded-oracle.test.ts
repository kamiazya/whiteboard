import { readdirSync, readFileSync } from 'node:fs'
import type { documentEngine } from '@kamiazya/whiteboard-model'
import { decodeImportBlobMeta, LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  answer,
  frontierPairs,
  type VersionPairs,
  versionPairs,
} from '../test-utils/crdt-read-oracle.js'
import { applyOracleWriter, ORACLE_WRITERS, RECORDED_NOW } from '../test-utils/crdt-write-oracle.js'

/**
 * The committed recording of what every writer of the loro cohort leaves behind
 * under loro-crdt 1.17.1, taken by `scripts/record-crdt-write-oracle.ts`. A row
 * carries the document's bytes before the write, the write, and the state, the
 * version, the frontiers and the update bytes after it — or the class of its
 * refusal. The Rust `whiteboard-crdt` crate replays it.
 */
const FILE = new URL('./crdt-write.jsonl', import.meta.url)
const SRC = new URL('../', import.meta.url)

interface Row {
  id: string
  op: string
  host: 'workspace' | 'document'
  peer: number
  before: string
  args: unknown
  result: unknown
  deep: unknown
  ids: unknown
  vv: VersionPairs
  frontiers: Array<[string, number]>
  update: string
}

const rows: Row[] = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Row)

const fresh = (b64: string) => {
  const doc = new LoroDoc()
  doc.import(new Uint8Array(Buffer.from(b64, 'base64')))
  return doc
}

/**
 * Rows each writer must hold, and how many of them must change the document.
 * Typed by the writer registry, so a writer added there owes an entry here.
 */
const WRITER_FLOORS = {
  writeSpatialCanvas: { rows: 8, changing: 4, refusing: 2 },
  writeSpatialNode: { rows: 6, changing: 6 },
  writeSpatialEdge: { rows: 6, changing: 6 },
  deleteSpatialNode: { rows: 6, changing: 1 },
  deleteSpatialEdge: { rows: 6, changing: 1 },
  reconcileSpatialCanvas: { rows: 12, changing: 6 },
  setNodeLock: { rows: 6, changing: 3 },
  setEdgeLock: { rows: 6, changing: 3 },
  withSpatialBatch: { rows: 6, changing: 6 },
  writeMarkdownBody: { rows: 12, changing: 8 },
  writeDocumentKind: { rows: 8, changing: 4 },
  writeFacets: { rows: 12, changing: 6, refusing: 2 },
  writeCoreFacets: { rows: 6, changing: 4 },
  writeTrustFacets: { rows: 3, changing: 3 },
  reconcileFacets: { rows: 8, changing: 8 },
  reconcileCoreFacets: { rows: 6, changing: 6 },
  writeCanvasFacetsField: { rows: 12, changing: 8, refusing: 2 },
  writeCommentThread: { rows: 12, changing: 12 },
  writeThreadMessage: { rows: 6, changing: 1 },
  setCommentThreadStatus: { rows: 6, changing: 1 },
  moveCommentThread: { rows: 6, changing: 1 },
  markThreadPassages: { rows: 4, changing: 2 },
  writeProposal: { rows: 8, changing: 8 },
  setProposedChangeStatus: { rows: 8, changing: 2 },
  withDocumentBatch: { rows: 8, changing: 3 },
  reconcileDocContent: { rows: 8, changing: 4 },
  writeWorkspaceDocumentContent: { rows: 12, changing: 8 },
  writeDocumentContentAndName: { rows: 8, changing: 6 },
  seedNameFromTitle: { rows: 6, changing: 1 },
  seedNamesFromTitles: { rows: 6, changing: 2 },
  stampEditedDocuments: { rows: 6, changing: 2 },
  createWorkspaceDocumentAtPath: { rows: 16, changing: 12, refusing: 4 },
  createWorkspaceDocument: { rows: 8, changing: 4, refusing: 4 },
  ensureFolderPath: { rows: 8, changing: 4 },
  moveWorkspaceDocument: { rows: 12, changing: 4, refusing: 4 },
  moveWorkspaceNodeToPath: { rows: 8, changing: 4 },
  setWorkspaceDocumentName: { rows: 12, changing: 8, refusing: 4 },
  setWorkspaceFolderName: { rows: 12, changing: 4, refusing: 4 },
  deleteWorkspaceDocument: { rows: 6, changing: 3 },
  deleteWorkspaceNode: { rows: 6, changing: 3 },
  deleteWorkspaceNodeAtPath: { rows: 6, changing: 3 },
  setWorkspaceLastCompactedAt: { rows: 6, changing: 6 },
  setWorkspacePinned: { rows: 8, changing: 4, refusing: 4 },
  updateWorkspaceDocumentMeta: { rows: 8, changing: 4, refusing: 4 },
  pruneEmptyFolders: { rows: 8, changing: 4 },
  recordTrashEntry: { rows: 6, changing: 3, refusing: 3 },
  duplicateWorkspaceDocument: { rows: 16, changing: 8 },
  spliceText: { rows: 16, changing: 8, refusing: 4 },
  forgetTrashEntry: { rows: 6, changing: 6 },
  reapplyFolderNames: { rows: 10, changing: 3 },
  minimalChange: { rows: 12, changing: 0 },
} satisfies Record<
  documentEngine.WriterName | 'minimalChange',
  { rows: number; changing: number; refusing?: number }
>

/**
 * Every exported function in this package that names a write, and where it is
 * recorded. A writer the registry does not hold is covered through one it does,
 * or is not a writer and says why.
 */
const OTHER_WRITES: Record<string, string> = {
  reconcileSpatialCanvasInto: 'covered by reconcileSpatialCanvas and withDocumentBatch',
  writeMarkdownBodyInto: 'covered by writeMarkdownBody and withDocumentBatch',
  setProposedChangeStatusInto: 'covered by setProposedChangeStatus and withDocumentBatch',
  syncRootContainer: 'covered by writeWorkspaceDocumentContent and reconcileDocContent',
  clearRootContainer: 'covered by writeWorkspaceDocumentContent and reconcileDocContent',
  copyContainerValue: 'covered by writeWorkspaceDocumentContent (projection and restore copies)',
  applyDocumentEdit:
    'covered by writeMarkdownBody, reconcileSpatialCanvas and writeSpatialNode, the writes each arm makes',
  openMergeableMap:
    'covered by writeCommentThread and writeProposal, which open every mergeable map',
  openMergeableMovableList: 'covered by setWorkspacePinned, the only mergeable list',
  openThreadCount: 'a read of a thread map',
  openProposedChangeCount: 'a read of a proposal map',
  importWorkspaceSubtree:
    'not recorded: its input is bytes exportWorkspaceSubtree makes under a random peer, so no argument is repeatable',
  importWithinTextLimits:
    'not recorded: the judge of an incoming update, not a writer of this slice',
  syncTextLimitJudge: 'not recorded: the judge of an incoming update, not a writer of this slice',
}

const WRITE_NAME =
  /^(write|set|reconcile|record|delete|create|move|duplicate|stamp|seed|mark|ensure|sync|clear|copy|open|with|update|prune|import|splice|apply)[A-Za-z]*$/

function exportedWriters(): string[] {
  const found = new Set<string>()
  for (const entry of readdirSync(SRC)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    const text = readFileSync(new URL(entry, SRC), 'utf8')
    for (const match of text.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const name = match[1] as string
      if (WRITE_NAME.test(name)) found.add(name)
    }
  }
  return [...found].sort()
}

/** Whether the write left an operation for a peer to import. */
const changed = (row: Row) =>
  decodeImportBlobMeta(new Uint8Array(Buffer.from(row.update, 'base64')), false).changeNum > 0

describe('the recorded CRDT write oracle', () => {
  it('holds every writer at its floor', () => {
    const byOp = new Map<string, Row[]>()
    for (const row of rows) byOp.set(row.op, [...(byOp.get(row.op) ?? []), row])
    for (const [op, floor] of Object.entries(WRITER_FLOORS)) {
      const held = byOp.get(op) ?? []
      const refusing = floor as { refusing?: number }
      expect(held.length, `rows of ${op}`).toBeGreaterThanOrEqual(floor.rows)
      expect(
        held.filter(changed).length,
        `rows of ${op} that changed the document`,
      ).toBeGreaterThanOrEqual(floor.changing)
      expect(
        held.filter((row) => 'err' in (row.result as object)).length,
        `rows of ${op} that were refused`,
      ).toBeGreaterThanOrEqual(refusing.refusing ?? 0)
    }
    expect(
      [...byOp.keys()].filter((op) => !(op in WRITER_FLOORS)),
      'rows of a writer with no floor',
    ).toEqual([])
    expect(rows.length, 'recorded rows').toBeGreaterThan(450)
  })

  it('classifies every exported writer as recorded or as covered', () => {
    const writers = exportedWriters()
    expect(writers.length, 'exported writers found').toBeGreaterThan(40)
    expect(
      writers.filter((name) => !(name in ORACLE_WRITERS) && !(name in OTHER_WRITES)),
      'exported writers neither recorded nor classified',
    ).toEqual([])
    expect(
      Object.keys(OTHER_WRITES).filter((name) => !writers.includes(name) || name in ORACLE_WRITERS),
      'classified writers that are gone or are recorded after all',
    ).toEqual([])
  })

  it('reaches both hosts, refusals, and writes by a second peer', () => {
    expect(rows.filter((r) => r.host === 'workspace').length, 'workspace rows').toBeGreaterThan(150)
    expect(rows.filter((r) => r.host === 'document').length, 'document rows').toBeGreaterThan(150)
    expect(
      rows.filter((r) => 'err' in (r.result as object)).length,
      'refused rows',
    ).toBeGreaterThan(30)
    expect(rows.filter((r) => r.peer !== 1).length, 'rows written by another peer').toBeGreaterThan(
      100,
    )
    expect(
      rows.filter((r) => /[\u{10000}-\u{10ffff}]/u.test(JSON.stringify(r.deep))).length,
      'rows holding a surrogate pair',
    ).toBeGreaterThan(20)
  })

  // Goes when the TypeScript writers go: the Rust crate replays the recording
  // against its own answers instead.
  describe('equals what npm loro-crdt and the TypeScript writers answer today (deleted with the TS)', () => {
    beforeAll(() => {
      vi.spyOn(Date, 'now').mockReturnValue(RECORDED_NOW)
    })
    afterAll(() => {
      vi.restoreAllMocks()
    })

    it.each(rows.map((row) => [row.id, row] as const))('%s', (_id, row) => {
      const doc = fresh(row.before)
      doc.setPeerId(BigInt(row.peer))
      const beforeVersion = doc.oplogVersion()
      const result = answer(() =>
        applyOracleWriter(doc, row.op, JSON.parse(JSON.stringify(row.args))),
      )
      doc.commit()
      expect(JSON.parse(JSON.stringify(result)), 'result').toEqual(row.result)
      const after = fresh(Buffer.from(doc.export({ mode: 'update' })).toString('base64'))
      expect(after.toJSON(), 'deep value').toEqual(row.deep)
      expect(after.getDeepValueWithID(), 'container ids').toEqual(row.ids)
      expect(versionPairs(doc.oplogVersion()), 'version vector').toEqual(row.vv)
      expect(frontierPairs(doc.frontiers()), 'frontiers').toEqual(row.frontiers)
      expect(
        Buffer.from(doc.export({ mode: 'update', from: beforeVersion })).toString('base64'),
        'update bytes',
      ).toEqual(row.update)
    })
  })
})
