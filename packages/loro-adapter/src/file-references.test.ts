import { bytesToBase64, newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { DocumentContainers } from './containers.js'
import { createCrdtEngine } from './engine/engine.js'
import { ownedLease, withLease } from './engine/lease.js'
import { scanFileReferencesOfLease } from './engine/lease-file-references.js'
import {
  type FileReferenceReads,
  scanFileReferences,
  scanFileReferencesOfRecord,
} from './file-references.js'
import { collectImageRefIds } from './image-refs.js'
import { legacyRecordOps } from './legacy-record-ops.js'
import { writeSpatialCanvas } from './loro-bridge.js'
import { writeProposal } from './proposals.js'
import { bindRecordOps } from './record-ops.js'
import { RetiredStoredShapeError } from './retired-stored-shape.js'
import { recordTrashEntry, type TrashEntry } from './workspace-trash.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  exportWorkspaceSubtree,
  projectWorkspaceDocument,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const LIVE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TRASHED = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const DIGEST = 'b'.repeat(64)

function imageDoc(fileId: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [
      fileNode({ id: `n-${fileId}`, file: newImageRef(fileId), x: 0, y: 0, width: 9, height: 9 }),
    ],
    edges: [],
  })
  return doc
}

function place(record: LoroDoc, path: string, documentId: string, fileId: string): void {
  createWorkspaceDocumentAtPath(record, { path, documentId, kind: 'spatial' })
  writeWorkspaceDocumentContent(record, documentId, imageDoc(fileId))
}

/** Deletes `path` the way both keepers do: evacuate the subtree, then record it in the trash. */
function trash(record: LoroDoc, path: string, documentId: string): Uint8Array {
  const bytes = exportWorkspaceSubtree(record, path)
  if (bytes === null) throw new Error(`nothing at ${path}`)
  deleteWorkspaceNodeAtPath(record, path)
  const entry: TrashEntry = {
    documentId,
    path,
    deletedAt: 1,
    blob: { algorithm: 'sha-256', digestHex: DIGEST },
  }
  recordTrashEntry(record, entry)
  return bytes
}

const noTrash: FileReferenceReads['trashBytes'] = async () => null

/**
 * The scan as an engine lease reads it: the record opens as a handle, and a
 * version's state is named by the images it holds rather than as containers.
 */
async function scanThroughLease(record: LoroDoc, reads: FileReferenceReads) {
  const engine = createCrdtEngine()
  const handle = engine.open({
    peer: '1',
    bytes: bytesToBase64(record.export({ mode: 'snapshot' })),
  }).handle
  const { versions } = reads
  return withLease(ownedLease(engine, handle), (leased) =>
    scanFileReferencesOfLease(leased, {
      trashBytes: (entry) => reads.trashBytes(entry),
      ...(versions === undefined
        ? {}
        : {
            versions: {
              list: (holder) => versions.list(holder),
              imageRefIds: async (holder, versionId) => {
                const past = await versions.load(holder, versionId)
                return past === null ? null : [...collectImageRefIds(past)]
              },
            },
          }),
      ...(reads.between === undefined
        ? {}
        : { between: () => reads.between?.() ?? Promise.resolve() }),
    }),
  )
}

/** The scan as a keeper holding the record through a session reads it. */
const scanThroughSession = (record: LoroDoc, reads: FileReferenceReads) =>
  scanFileReferencesOfRecord(
    bindRecordOps(legacyRecordOps, record, async () => {}),
    reads,
  )

const SCANS = [
  ['a LoroDoc', scanFileReferences],
  ['a record session', scanThroughSession],
  ['an engine lease', scanThroughLease],
] as const

describe.each(SCANS)('scanFileReferences over %s', (_name, scanOf) => {
  it('collects what a live document draws', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-live')

    const scan = await scanOf(record, { trashBytes: noTrash })

    expect(scan.referenced).toEqual(new Set(['img-live']))
    expect(scan.unjudged).toEqual([])
  })

  it('keeps an image only an undecided proposal names, so adopting it draws', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-live')
    const node = fileNode({
      id: 'n-p',
      file: newImageRef('img-proposed'),
      x: 20,
      y: 0,
      width: 9,
      height: 9,
    })
    writeProposal(documentContainers(record, LIVE), {
      id: 'p1',
      changes: [{ id: 'c1', status: 'open', op: 'node.add', node }],
    })

    const scan = await scanOf(record, { trashBytes: noTrash })

    expect(scan.referenced).toEqual(new Set(['img-live', 'img-proposed']))
    expect(scan.unjudged).toEqual([])
  })

  it('collects what a shadowed document draws, though its path names another', async () => {
    // Two peers each create a document at one path; the merge keeps both.
    const record = new LoroDoc()
    const peer = new LoroDoc()
    place(record, 'same', LIVE, 'img-first')
    place(peer, 'same', TRASHED, 'img-second')
    record.import(peer.export({ mode: 'snapshot' }))

    const scan = await scanOf(record, { trashBytes: noTrash })

    expect(scan.referenced).toEqual(new Set(['img-first', 'img-second']))
  })

  it('keeps what only a trashed document draws, read from its evacuated bytes', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    const bytes = trash(record, 'gone', TRASHED)

    const scan = await scanOf(record, { trashBytes: async () => bytes })

    expect(scan.referenced).toEqual(new Set(['img-trash']))
  })

  it('reads nothing for a trash entry whose bytes are gone', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    trash(record, 'gone', TRASHED)

    const scan = await scanOf(record, { trashBytes: noTrash })

    expect(scan.referenced).toEqual(new Set())
    expect(scan.unjudged).toEqual([])
  })

  it('reports a trash entry whose bytes hold no document as unjudged', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    trash(record, 'gone', TRASHED)

    const scan = await scanOf(record, {
      trashBytes: async () => new LoroDoc().export({ mode: 'snapshot' }),
    })

    expect(scan.unjudged).toMatchObject([
      { kind: 'trash', documentId: TRASHED, cause: { message: 'trash bytes hold no document' } },
    ])
  })

  it('reports a trash entry whose bytes hold another document as unjudged', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    place(record, 'other', LIVE, 'img-other')
    const other = trash(record, 'other', LIVE)
    trash(record, 'gone', TRASHED)

    const scan = await scanOf(record, {
      trashBytes: async (entry) => (entry.documentId === TRASHED ? other : null),
    })

    expect(scan.unjudged).toMatchObject([
      {
        kind: 'trash',
        documentId: TRASHED,
        cause: { message: 'trash bytes hold a different document' },
      },
    ])
    expect(scan.referenced).toEqual(new Set())
  })

  it('keeps what only a saved version of a live document draws', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-then')
    const then = record.oplogFrontiers()
    writeWorkspaceDocumentContent(record, LIVE, imageDoc('img-now'))
    const versions: NonNullable<FileReferenceReads['versions']> = {
      list: async (holder) => (holder.documentId === LIVE ? ['v1'] : []),
      load: async (holder): Promise<DocumentContainers | null> => {
        const past = record.fork()
        past.checkout(then)
        return projectWorkspaceDocument(past, holder.documentId)
      },
    }

    const scan = await scanOf(record, { trashBytes: noTrash, versions })

    expect(scan.referenced).toEqual(new Set(['img-then', 'img-now']))
  })

  it('asks for the saved versions of a trashed document too', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    const bytes = trash(record, 'gone', TRASHED)
    const asked: { documentId: string; trashed: boolean }[] = []

    await scanOf(record, {
      trashBytes: async () => bytes,
      versions: {
        list: async (holder) => {
          asked.push({ documentId: holder.documentId, trashed: holder.trashed })
          return []
        },
        load: async () => null,
      },
    })

    expect(asked).toEqual([{ documentId: TRASHED, trashed: true }])
  })

  it('reports a version that cannot be read as unjudged, with where it belongs', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-live')

    const scan = await scanOf(record, {
      trashBytes: noTrash,
      versions: {
        list: async () => ['v-broken', 'v-null'],
        load: async (_holder, versionId) => {
          if (versionId === 'v-broken') throw new Error('frontier rows missing')
          return null
        },
      },
    })

    expect(scan.unjudged).toMatchObject([
      { kind: 'version', documentId: LIVE, path: 'live', versionId: 'v-broken' },
      {
        kind: 'version',
        documentId: LIVE,
        path: 'live',
        versionId: 'v-null',
        cause: { message: 'a listed version could not be loaded' },
      },
    ])
  })

  it('reports a workspace node this build cannot read as unjudged', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-live')
    // A kind this build lacks, as a newer peer could have written it.
    for (const node of record.getTree('tree').getNodes()) node.data.set('kind', 'future-kind')
    record.commit()

    const scan = await scanOf(record, { trashBytes: noTrash })

    expect(scan.unjudged).toMatchObject([{ kind: 'unreadable-node' }])
  })

  it('awaits the yield between every unit it reads', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-live')
    place(record, 'gone', TRASHED, 'img-trash')
    const bytes = trash(record, 'gone', TRASHED)
    let yields = 0

    await scanOf(record, {
      trashBytes: async () => bytes,
      versions: { list: async () => ['v1'], load: async () => null },
      between: async () => {
        yields += 1
      },
    })

    // One trash entry, one live document, and one version for each of them.
    expect(yields).toBe(4)
  })
})

describe.each([
  ['a LoroDoc', scanFileReferences],
  ['a record session', scanThroughSession],
] as const)('scanFileReferences over %s, for a document in a retired shape', (_name, scanOf) => {
  it('refuses with the error the document itself raises, so the operator is told what to do', async () => {
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, { path: 'old', documentId: LIVE, kind: 'spatial' })
    const retired = new LoroDoc()
    const elements = retired.getMovableList('elements')
    elements.insertContainer(0, new LoroMap()).set('id', 'e1')
    retired.commit()
    writeWorkspaceDocumentContent(record, LIVE, retired)

    await expect(scanOf(record, { trashBytes: noTrash })).rejects.toBeInstanceOf(
      RetiredStoredShapeError,
    )
  })
})
