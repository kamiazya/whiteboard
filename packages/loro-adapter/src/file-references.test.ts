import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { DocumentContainers } from './containers.js'
import { type FileReferenceReads, scanFileReferences } from './file-references.js'
import { writeSpatialCanvas } from './loro-bridge.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  exportWorkspaceSubtree,
  projectWorkspaceDocument,
  recordTrashEntry,
  type TrashEntry,
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

describe('scanFileReferences', () => {
  it('collects what a live document draws', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-live')

    const scan = await scanFileReferences(record, { trashBytes: noTrash })

    expect(scan.referenced).toEqual(new Set(['img-live']))
    expect(scan.unjudged).toEqual([])
  })

  it('collects what a shadowed document draws, though its path names another', async () => {
    // Two peers each create a document at one path; the merge keeps both.
    const record = new LoroDoc()
    const peer = new LoroDoc()
    place(record, 'same', LIVE, 'img-first')
    place(peer, 'same', TRASHED, 'img-second')
    record.import(peer.export({ mode: 'snapshot' }))

    const scan = await scanFileReferences(record, { trashBytes: noTrash })

    expect(scan.referenced).toEqual(new Set(['img-first', 'img-second']))
  })

  it('keeps what only a trashed document draws, read from its evacuated bytes', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    const bytes = trash(record, 'gone', TRASHED)

    const scan = await scanFileReferences(record, { trashBytes: async () => bytes })

    expect(scan.referenced).toEqual(new Set(['img-trash']))
  })

  it('reads nothing for a trash entry whose bytes are gone', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    trash(record, 'gone', TRASHED)

    const scan = await scanFileReferences(record, { trashBytes: noTrash })

    expect(scan.referenced).toEqual(new Set())
    expect(scan.unjudged).toEqual([])
  })

  it('reports a trash entry whose bytes hold no document as unjudged', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    trash(record, 'gone', TRASHED)

    const scan = await scanFileReferences(record, {
      trashBytes: async () => new LoroDoc().export({ mode: 'snapshot' }),
    })

    expect(scan.unjudged).toMatchObject([{ kind: 'trash', documentId: TRASHED }])
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

    const scan = await scanFileReferences(record, { trashBytes: noTrash, versions })

    expect(scan.referenced).toEqual(new Set(['img-then', 'img-now']))
  })

  it('asks for the saved versions of a trashed document too', async () => {
    const record = new LoroDoc()
    place(record, 'gone', TRASHED, 'img-trash')
    const bytes = trash(record, 'gone', TRASHED)
    const asked: { documentId: string; trashed: boolean }[] = []

    await scanFileReferences(record, {
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

    const scan = await scanFileReferences(record, {
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
      { kind: 'version', documentId: LIVE, path: 'live', versionId: 'v-null' },
    ])
  })

  it('reports a workspace node this build cannot read as unjudged', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-live')
    // A kind this build lacks, as a newer peer could have written it.
    for (const node of record.getTree('tree').getNodes()) node.data.set('kind', 'future-kind')
    record.commit()

    const scan = await scanFileReferences(record, { trashBytes: noTrash })

    expect(scan.unjudged).toMatchObject([{ kind: 'unreadable-node' }])
  })

  it('awaits the yield between every unit it reads', async () => {
    const record = new LoroDoc()
    place(record, 'live', LIVE, 'img-live')
    place(record, 'gone', TRASHED, 'img-trash')
    const bytes = trash(record, 'gone', TRASHED)
    let yields = 0

    await scanFileReferences(record, {
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
