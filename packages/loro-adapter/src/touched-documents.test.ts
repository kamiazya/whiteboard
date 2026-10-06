/**
 * Which documents a workspace import wrote to, read off the imported
 * operations, and the edit stamp a keeper puts on the ones whose CONTENT it
 * changed. Driven through a replica's update, the shape every keeper takes.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { documentsTouchedSince, stampEditedDocuments } from './touched-documents.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
} from './workspace-tree.js'

const NOTE = '01J0000000000000000000N0TE'
const OTHER = '01J00000000000000000000THR'
const FRESH = '01J0000000000000000000FRSH'
const CREATED = 1_000

function keeper(): LoroDoc {
  const workspace = new LoroDoc()
  for (const [documentId, path] of [
    [NOTE, 'notes/weekly'],
    [OTHER, 'other'],
  ] as const) {
    createWorkspaceDocumentAtPath(workspace, {
      path,
      documentId,
      kind: 'markdown',
      createdAt: CREATED,
    })
  }
  workspace.commit()
  return workspace
}

/** Imports what `edit` does on a replica, answering the keeper's version before it. */
function imported(workspace: LoroDoc, edit: (replica: LoroDoc) => void) {
  const replica = new LoroDoc()
  replica.import(workspace.export({ mode: 'snapshot' }))
  const from = replica.oplogVersion()
  edit(replica)
  replica.commit()
  const since = workspace.oplogVersion()
  workspace.import(replica.export({ mode: 'update', from }))
  return since
}

const type = (documentId: string, text: string) => (replica: LoroDoc) => {
  documentContainers(replica, documentId).getText(MARKDOWN_BODY_KEY).insert(0, text)
}

const updatedAtOf = (workspace: LoroDoc, documentId: string) =>
  resolveWorkspaceDocumentById(workspace, documentId)?.updatedAt

describe('documentsTouchedSince', () => {
  it('answers each document the import wrote to, with its path and that its content moved', () => {
    const workspace = keeper()
    const since = imported(workspace, (replica) => {
      type(NOTE, 'hello')(replica)
      type(OTHER, 'there')(replica)
    })

    const touched = documentsTouchedSince(workspace, since)

    expect(
      touched
        .map(({ documentId, path, contentWritten }) => ({ documentId, path, contentWritten }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual([
      { documentId: NOTE, path: 'notes/weekly', contentWritten: true },
      { documentId: OTHER, path: 'other', contentWritten: true },
    ])
  })

  it('leaves out a document nothing in the import wrote to', () => {
    const workspace = keeper()
    const since = imported(workspace, type(NOTE, 'hello'))

    expect(documentsTouchedSince(workspace, since).map((each) => each.documentId)).toEqual([NOTE])
  })

  it('answers nothing for an import it already held', () => {
    const workspace = keeper()
    const replica = new LoroDoc()
    replica.import(workspace.export({ mode: 'snapshot' }))
    const from = replica.oplogVersion()
    type(NOTE, 'hello')(replica)
    replica.commit()
    const update = replica.export({ mode: 'update', from })
    workspace.import(update)
    const since = workspace.oplogVersion()
    workspace.import(update)

    expect(documentsTouchedSince(workspace, since)).toEqual([])
  })

  it('counts a write to the node’s own naming as touched but not as content', () => {
    const workspace = keeper()
    const since = imported(workspace, (replica) =>
      setWorkspaceDocumentName(replica, { documentId: NOTE, name: 'Weekly' }),
    )

    expect(documentsTouchedSince(workspace, since)).toEqual([
      expect.objectContaining({ documentId: NOTE, contentWritten: false }),
    ])
  })

  it('counts a document the import created empty as touched but not written', () => {
    const workspace = keeper()
    const since = imported(workspace, (replica) =>
      createWorkspaceDocumentAtPath(replica, {
        path: 'fresh',
        documentId: FRESH,
        kind: 'markdown',
      }),
    )

    expect(documentsTouchedSince(workspace, since)).toEqual([
      expect.objectContaining({ documentId: FRESH, path: 'fresh', contentWritten: false }),
    ])
  })

  it('passes over a document the same import deleted', () => {
    const workspace = keeper()
    const since = imported(workspace, (replica) => {
      type(NOTE, 'hello')(replica)
      deleteWorkspaceDocument(replica, { documentId: NOTE })
    })

    expect(documentsTouchedSince(workspace, since)).toEqual([])
  })
})

describe('stampEditedDocuments', () => {
  it('stamps updatedAt on a document whose content the import wrote, and no other', () => {
    const workspace = keeper()
    const since = imported(workspace, type(NOTE, 'hello'))

    stampEditedDocuments(workspace, documentsTouchedSince(workspace, since), 5_000)

    expect(updatedAtOf(workspace, NOTE)).toBe(5_000)
    expect(updatedAtOf(workspace, OTHER)).toBe(CREATED)
  })

  it('writes nothing for a document only renamed', () => {
    const workspace = keeper()
    const since = imported(workspace, (replica) =>
      setWorkspaceDocumentName(replica, { documentId: NOTE, name: 'Weekly' }),
    )
    const after = workspace.oplogVersion().toJSON()

    stampEditedDocuments(workspace, documentsTouchedSince(workspace, since), 5_000)

    expect(updatedAtOf(workspace, NOTE)).toBe(CREATED)
    expect(workspace.oplogVersion().toJSON()).toEqual(after)
  })
})
