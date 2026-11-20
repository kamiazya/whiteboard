/**
 * What one workspace-document update leaves behind, by class of update: the
 * answer or the refusal (class, code, message), what was saved and dropped, and
 * what the stored record holds afterwards. The operation is free to change how
 * it holds the record; these outcomes are what a surface and a replica see.
 */
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  MARKDOWN_BODY_KEY,
  readTrashEntries,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { FakeBlobStore } from '../test-utils/fake-blob-store.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'

const WS = 'ws-1'
const NOTE = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const OTHER = '01BRWAAAAAAAAAAAAAAAAAAAA3'
const NEW = '01BRWAAAAAAAAAAAAAAAAAAAA4'
const SEED_STAMP = 1_000

/** One history every client and the keeper start from, so an update's dependencies exist. */
const SEED = (() => {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'note', documentId: NOTE, kind: 'markdown' })
  createWorkspaceDocumentAtPath(doc, { path: 'folder/other', documentId: OTHER, kind: 'markdown' })
  for (const node of doc.getTree('tree').getNodes()) {
    if (node.data.get('documentId') !== undefined) node.data.set('updatedAt', SEED_STAMP)
  }
  doc.commit()
  return doc
})()

function updateFrom(edit: (client: LoroDoc) => void): Uint8Array {
  const client = SEED.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

const insertBody = (documentId: string, text: string) => (client: LoroDoc) =>
  documentContainers(client, documentId).getText(MARKDOWN_BODY_KEY).insert(0, text)

/** An update that builds on a change the keeper never received. */
function updateBuildingOnAMissingOne(): Uint8Array {
  const client = SEED.fork()
  insertBody(NOTE, 'one')(client)
  client.commit()
  const middle = client.oplogVersion()
  client.getText('scratch').insert(0, 'x')
  documentContainers(client, NOTE).getText(MARKDOWN_BODY_KEY).insert(0, 'two')
  client.commit()
  return client.export({ mode: 'update', from: middle })
}

/** What a follower holding the seed ends up with from the updates the saves fanned out. */
function followersOf(updates: readonly Uint8Array[]) {
  const follower = LoroDoc.fromSnapshot(SEED.export({ mode: 'snapshot' }))
  for (const update of updates) follower.import(update)
  return {
    updates: updates.length,
    documents: readWorkspaceDocuments(follower).map(({ documentId, path, name, updatedAt }) => ({
      documentId,
      path,
      name,
      stamped: updatedAt !== undefined && updatedAt > SEED_STAMP,
    })),
    trash: readTrashEntries(follower).map(({ documentId, path }) => ({ documentId, path })),
  }
}

async function outcomeOf(
  update: Uint8Array,
  input: { mayPlaceDocuments?: boolean } = {},
): Promise<Record<string, unknown>> {
  const store = new StoredDoc(SEED)
  const announced: string[] = []
  const saved: Uint8Array[] = []
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    get: async () => store.get(),
    save: async (_workspaceId, doc) => {
      saved.push(doc.export({ mode: 'update', from: SEED.oplogVersion() }))
      store.save(doc)
    },
    evict: () => store.evict(),
    evictProjections: () => announced.push('projections'),
  }
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
  }
  const blobs = new FakeBlobStore()
  let answer: Record<string, unknown>
  try {
    const result = await applyWorkspaceDocumentUpdate(
      { workspaceDocuments, liveDocuments, blobStore: blobs },
      { workspaceId: WS, update, ...input },
    )
    answer = { result }
  } catch (err) {
    const refusal = err as Error & { code?: string }
    answer = { threw: refusal.name, code: refusal.code, message: refusal.message }
  }
  const stored = LoroDoc.fromSnapshot(store.get().export({ mode: 'snapshot' }))
  return {
    ...answer,
    saves: store.saves,
    evictions: store.evictions,
    projectionsEvicted: announced.length,
    followers: followersOf(saved),
    documents: readWorkspaceDocuments(stored).map(({ documentId, path, name, updatedAt }) => ({
      documentId,
      path,
      name,
      stamped: updatedAt !== undefined && updatedAt > SEED_STAMP,
    })),
    trash: readTrashEntries(stored).map(({ documentId, path }) => ({ documentId, path })),
  }
}

describe('the outcome of applying one workspace-document update', () => {
  it('a body edit is applied, stamps the note and answers it as edited', async () => {
    const out = await outcomeOf(updateFrom(insertBody(NOTE, '# Weekly review')))
    expect(out).toMatchInlineSnapshot(`
      {
        "documents": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
            "name": undefined,
            "path": "note",
            "stamped": true,
          },
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
            "name": undefined,
            "path": "folder/other",
            "stamped": false,
          },
        ],
        "evictions": 0,
        "followers": {
          "documents": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "name": undefined,
              "path": "note",
              "stamped": true,
            },
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
              "name": undefined,
              "path": "folder/other",
              "stamped": false,
            },
          ],
          "trash": [],
          "updates": 1,
        },
        "projectionsEvicted": 1,
        "result": {
          "edited": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "path": "note",
            },
          ],
          "kind": "applied",
        },
        "saves": 1,
        "trash": [],
      }
    `)
  })

  it('a new document is applied and is not an edit', async () => {
    const out = await outcomeOf(
      updateFrom((client) =>
        createWorkspaceDocumentAtPath(client, { path: 'fresh', documentId: NEW, kind: 'markdown' }),
      ),
    )
    expect(out).toMatchInlineSnapshot(`
      {
        "documents": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
            "name": undefined,
            "path": "note",
            "stamped": false,
          },
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
            "name": undefined,
            "path": "folder/other",
            "stamped": false,
          },
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA4",
            "name": undefined,
            "path": "fresh",
            "stamped": true,
          },
        ],
        "evictions": 0,
        "followers": {
          "documents": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "name": undefined,
              "path": "note",
              "stamped": false,
            },
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
              "name": undefined,
              "path": "folder/other",
              "stamped": false,
            },
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA4",
              "name": undefined,
              "path": "fresh",
              "stamped": true,
            },
          ],
          "trash": [],
          "updates": 1,
        },
        "projectionsEvicted": 1,
        "result": {
          "edited": [],
          "kind": "applied",
        },
        "saves": 1,
        "trash": [],
      }
    `)
  })

  it('a removed document is applied and left in the trash', async () => {
    const out = await outcomeOf(
      updateFrom((client) => deleteWorkspaceDocument(client, { documentId: OTHER })),
    )
    expect(out).toMatchInlineSnapshot(`
      {
        "documents": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
            "name": undefined,
            "path": "note",
            "stamped": false,
          },
        ],
        "evictions": 0,
        "followers": {
          "documents": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "name": undefined,
              "path": "note",
              "stamped": false,
            },
          ],
          "trash": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
              "path": "folder/other",
            },
          ],
          "updates": 1,
        },
        "projectionsEvicted": 1,
        "result": {
          "edited": [],
          "kind": "applied",
        },
        "saves": 1,
        "trash": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
            "path": "folder/other",
          },
        ],
      }
    `)
  })

  it('a run past the text bound is refused, saving nothing and dropping the record', async () => {
    const out = await outcomeOf(updateFrom(insertBody(NOTE, 'y'.repeat(2_000_000))))
    expect(out).toMatchInlineSnapshot(`
      {
        "code": "markdown_too_large",
        "documents": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
            "name": undefined,
            "path": "note",
            "stamped": false,
          },
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
            "name": undefined,
            "path": "folder/other",
            "stamped": false,
          },
        ],
        "evictions": 1,
        "followers": {
          "documents": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "name": undefined,
              "path": "note",
              "stamped": false,
            },
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
              "name": undefined,
              "path": "folder/other",
              "stamped": false,
            },
          ],
          "trash": [],
          "updates": 0,
        },
        "message": "This update inserts 2000000 characters in one piece, past the 262144-character limit for one document; split the content across documents",
        "projectionsEvicted": 1,
        "saves": 0,
        "threw": "MarkdownBodyTooLargeError",
        "trash": [],
      }
    `)
  }, 30_000)

  it('a path outside the grammar is refused, saving nothing and dropping the record', async () => {
    const out = await outcomeOf(
      updateFrom((client) => {
        const node = client
          .getTree('tree')
          .getNodes()
          .find((candidate) => candidate.data.get('documentId') === NOTE)
        node?.data.set('segment', 'not a segment')
      }),
    )
    expect(out).toMatchInlineSnapshot(`
      {
        "code": "invalid_path",
        "documents": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
            "name": undefined,
            "path": "note",
            "stamped": false,
          },
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
            "name": undefined,
            "path": "folder/other",
            "stamped": false,
          },
        ],
        "evictions": 1,
        "followers": {
          "documents": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "name": undefined,
              "path": "note",
              "stamped": false,
            },
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
              "name": undefined,
              "path": "folder/other",
              "stamped": false,
            },
          ],
          "trash": [],
          "updates": 0,
        },
        "message": "This update would put documents or folders at paths this keeper cannot store: "not a segment". A path may be at most 1024 characters, and each segment may hold only ASCII letters, digits and interior hyphens",
        "projectionsEvicted": 1,
        "saves": 0,
        "threw": "OffGrammarPathError",
        "trash": [],
      }
    `)
  })

  it('an update building on a change the keeper lacks is refused as a causal gap', async () => {
    const out = await outcomeOf(updateBuildingOnAMissingOne())
    expect(out).toMatchInlineSnapshot(`
      {
        "code": "causal_gap",
        "documents": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
            "name": undefined,
            "path": "note",
            "stamped": false,
          },
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
            "name": undefined,
            "path": "folder/other",
            "stamped": false,
          },
        ],
        "evictions": 1,
        "followers": {
          "documents": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "name": undefined,
              "path": "note",
              "stamped": false,
            },
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
              "name": undefined,
              "path": "folder/other",
              "stamped": false,
            },
          ],
          "trash": [],
          "updates": 0,
        },
        "message": "This update builds on changes this keeper has not received yet, so nothing of it was kept. Send the changes it builds on first",
        "projectionsEvicted": 1,
        "saves": 0,
        "threw": "CausalGapError",
        "trash": [],
      }
    `)
  })

  it('an update that reorganises the tree is refused for a caller who may not place documents', async () => {
    const out = await outcomeOf(
      updateFrom((client) => deleteWorkspaceDocument(client, { documentId: OTHER })),
      { mayPlaceDocuments: false },
    )
    expect(out).toMatchInlineSnapshot(`
      {
        "documents": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
            "name": undefined,
            "path": "note",
            "stamped": false,
          },
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
            "name": undefined,
            "path": "folder/other",
            "stamped": false,
          },
        ],
        "evictions": 1,
        "followers": {
          "documents": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "name": undefined,
              "path": "note",
              "stamped": false,
            },
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
              "name": undefined,
              "path": "folder/other",
              "stamped": false,
            },
          ],
          "trash": [],
          "updates": 0,
        },
        "projectionsEvicted": 1,
        "result": {
          "kind": "placement-refused",
        },
        "saves": 0,
        "trash": [],
      }
    `)
  })

  it('bytes that are no update are answered malformed, saving and dropping nothing', async () => {
    const out = await outcomeOf(new Uint8Array([1, 2, 3, 4, 5, 6]))
    expect(out).toMatchInlineSnapshot(`
      {
        "documents": [
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
            "name": undefined,
            "path": "note",
            "stamped": false,
          },
          {
            "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
            "name": undefined,
            "path": "folder/other",
            "stamped": false,
          },
        ],
        "evictions": 0,
        "followers": {
          "documents": [
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA1",
              "name": undefined,
              "path": "note",
              "stamped": false,
            },
            {
              "documentId": "01BRWAAAAAAAAAAAAAAAAAAAA3",
              "name": undefined,
              "path": "folder/other",
              "stamped": false,
            },
          ],
          "trash": [],
          "updates": 0,
        },
        "projectionsEvicted": 0,
        "result": {
          "kind": "malformed-update",
        },
        "saves": 0,
        "trash": [],
      }
    `)
  })
})
