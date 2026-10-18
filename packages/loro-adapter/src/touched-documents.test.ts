/**
 * Which documents a workspace import wrote to, read off the imported
 * operations, and the edit stamp a keeper puts on the ones whose CONTENT it
 * changed. Driven through a replica's update, the shape every keeper takes.
 */
import { LoroDoc, LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { writeDocumentKind } from './document-envelope.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  documentsTouchedSince,
  organisationChangedSince,
  stampEditedDocuments,
} from './touched-documents.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  moveWorkspaceDocument,
  moveWorkspaceNodeToPath,
  recordTrashEntry,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
  setWorkspaceLastCompactedAt,
  setWorkspacePinned,
  updateWorkspaceDocumentMeta,
} from './workspace-tree.js'

const NOTE = '01J0000000000000000000N0TE'
const OTHER = '01J00000000000000000000THR'
const FRESH = '01J0000000000000000000FRSH'
const MOVABLE = '01J0000000000000000000MVBE'
const CREATED = 1_000

function keeper(): LoroDoc {
  const workspace = new LoroDoc()
  for (const [documentId, path] of [
    [NOTE, 'notes/weekly'],
    [OTHER, 'other'],
    [MOVABLE, 'notes/movable'],
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

type Edit = (replica: LoroDoc) => void

// What a replica sends while only editing what documents SAY: their content,
// their display name, their edit stamps. The envelope's own `kind` shares a
// key with the node's, one container further down.
const CONTENT_EDITS: Readonly<Record<string, Edit>> = {
  typeNote: type(NOTE, 'hello'),
  envelopeKind: (replica) => writeDocumentKind(documentContainers(replica, OTHER), 'markdown'),
  typeOther: type(OTHER, 'there'),
  nameNote: (replica) => setWorkspaceDocumentName(replica, { documentId: NOTE, name: 'Weekly' }),
  stampOther: (replica) => {
    updateWorkspaceDocumentMeta(replica, OTHER, { updatedAt: 9_000 })
  },
}

// What changes how the workspace is organised: which documents it holds or
// where, its trash, its pins. Each touches only `MOVABLE`, a new document or
// the workspace's own meta, so any of them can sit anywhere among the content
// edits above.
const ORGANISATION_EDITS: Readonly<Record<string, Edit>> = {
  create: (replica) => {
    createWorkspaceDocumentAtPath(replica, { path: 'fresh', documentId: FRESH, kind: 'markdown' })
  },
  createUnderNewFolders: (replica) => {
    createWorkspaceDocumentAtPath(replica, {
      path: 'deep/er/fresh',
      documentId: FRESH,
      kind: 'markdown',
    })
  },
  delete: (replica) => deleteWorkspaceDocument(replica, { documentId: MOVABLE }),
  reparent: (replica) => moveWorkspaceDocument(replica, { documentId: MOVABLE, parentId: OTHER }),
  toRoot: (replica) => moveWorkspaceDocument(replica, { documentId: MOVABLE }),
  movePath: (replica) => {
    moveWorkspaceNodeToPath(replica, 'notes/movable', 'elsewhere')
  },
  resegment: (replica) => {
    const node = replica
      .getTree('tree')
      .getNodes()
      .find((each) => each.data.get('documentId') === MOVABLE)
    node?.data.set('segment', 'renamed')
  },
  rekind: (replica) => {
    updateWorkspaceDocumentMeta(replica, MOVABLE, { kind: 'spatial' })
  },
  pin: (replica) => setWorkspacePinned(replica, NOTE, true),
  trash: (replica) =>
    recordTrashEntry(replica, {
      documentId: FRESH,
      path: 'gone',
      deletedAt: 1,
      blob: { algorithm: 'sha-256', digestHex: '0'.repeat(64) },
    }),
  compactionStamp: (replica) => setWorkspaceLastCompactedAt(replica, 1),
  strayRoot: (replica) => {
    replica.getMap('stray').set('k', 'v')
  },
}

describe('organisationChangedSince', () => {
  it('answers false for an import that only edits content', () => {
    const workspace = keeper()
    const since = imported(workspace, type(NOTE, 'hello'))

    expect(organisationChangedSince(workspace, since)).toBe(false)
  })

  it.each(Object.keys(ORGANISATION_EDITS))('answers true for an import that does %s', (name) => {
    const workspace = keeper()
    const since = imported(workspace, ORGANISATION_EDITS[name] as Edit)

    expect(organisationChangedSince(workspace, since)).toBe(true)
  })

  // An edit inside a container held at a meta key sits one level below the
  // node's map, where content edits sit — and can still rename or re-place it.
  it.each([
    ['segment', 'weekly'],
    ['name', 'Weekly'],
    ['documentId', NOTE],
  ])('answers true for an edit inside %s held as a container', (key, text) => {
    const workspace = keeper()
    const node = workspace
      .getTree('tree')
      .getNodes()
      .find((each) => each.data.get('documentId') === NOTE)
    node?.data.setContainer(key, new LoroText()).insert(0, text)
    workspace.commit()
    const since = imported(workspace, (replica) => {
      const held = replica
        .getTree('tree')
        .getNodes()
        .map((each) => each.data.get(key))
        .find((value) => value instanceof LoroText)
      if (!(held instanceof LoroText)) throw new Error(`no ${key} container`)
      held.insert(held.length, '/..')
    })

    expect(organisationChangedSince(workspace, since)).toBe(true)
  })

  it('answers false for an import it already held, whatever that import did', () => {
    const workspace = keeper()
    const replica = new LoroDoc()
    replica.import(workspace.export({ mode: 'snapshot' }))
    const from = replica.oplogVersion()
    deleteWorkspaceDocument(replica, { documentId: NOTE })
    const update = replica.export({ mode: 'update', from })
    workspace.import(update)
    const since = workspace.oplogVersion()
    workspace.import(update)

    expect(organisationChangedSince(workspace, since)).toBe(false)
  })

  fcTest.prop(
    [
      fc.array(fc.constantFrom(...Object.keys(CONTENT_EDITS)), { maxLength: 6 }),
      fc.option(
        fc.record({
          at: fc.nat(),
          edit: fc.constantFrom(...Object.keys(ORGANISATION_EDITS)),
        }),
      ),
    ],
    withDefaults({ numRuns: 60 }),
  )(
    'answers true exactly when some edit in the import changes the organisation',
    (content, placed) => {
      const edits = content.map((name) => CONTENT_EDITS[name] as Edit)
      if (placed !== null) {
        edits.splice(placed.at % (edits.length + 1), 0, ORGANISATION_EDITS[placed.edit] as Edit)
      }
      const workspace = keeper()
      const since = imported(workspace, (replica) => {
        for (const edit of edits) edit(replica)
      })

      expect(organisationChangedSince(workspace, since)).toBe(placed !== null)
    },
  )
})
