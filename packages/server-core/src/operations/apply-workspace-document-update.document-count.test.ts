/**
 * How many documents a workspace-document sync update may leave the record
 * holding — the same ceiling a promote carries, since an update can bring in
 * a whole record's worth of documents just as a promote can.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readWorkspaceDocuments,
  WORKSPACE_TREE_KEY,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { syncWriteAnswer, WORKSPACE_MAX_DOCUMENTS } from './sync-write-refusals.js'

const WS = 'ws-1'

/** `n` in the ULID alphabet, so a minted id is canonical. */
function crockford(n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  let rest = n
  do {
    out = alphabet[rest % 32] + out
    rest = Math.floor(rest / 32)
  } while (rest > 0)
  return out
}

const idOf = (i: number) => `01BRWC${crockford(i).padStart(20, '0')}`

/** A workspace record holding `count` markdown documents at `d0`, `d1`, … */
function recordOf(count: number): LoroDoc {
  const record = new LoroDoc()
  const tree = record.getTree(WORKSPACE_TREE_KEY)
  for (let i = 0; i < count; i++) {
    const node = tree.createNode()
    node.data.set('documentId', idOf(i))
    node.data.set('segment', `d${i}`)
    node.data.set('kind', 'markdown')
    node.data.set('createdAt', 1_000)
    node.data.set('updatedAt', 1_000)
  }
  record.commit()
  return record
}

function workspaceDeps(store: StoredDoc) {
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    get: async () => store.get(),
    save: async (_workspaceId, doc) => store.save(doc),
    evict: () => store.evict(),
    evictProjections: () => {},
  }
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
  }
  return { liveDocuments, workspaceDocuments }
}

/** What a client holding `base` would send after `edit`. */
function updateFrom(base: LoroDoc, edit: (doc: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

const addDocument = (path: string, documentId: string) => (doc: LoroDoc) =>
  createWorkspaceDocumentAtPath(doc, { path, documentId, kind: 'markdown' })

const storedCount = (store: StoredDoc) => readWorkspaceDocuments(store.get()).length

describe('a workspace-document sync update and the document ceiling', () => {
  it('refuses an update that takes the record past the ceiling, keeping none of it', async () => {
    const seed = recordOf(WORKSPACE_MAX_DOCUMENTS)
    const store = new StoredDoc(seed)
    const update = updateFrom(seed, addDocument('one-more', idOf(WORKSPACE_MAX_DOCUMENTS)))

    const refusal = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    }).catch((err: unknown) => err)

    expect(syncWriteAnswer(refusal)).toEqual({ code: 'too_many_documents', status: 413 })
    expect((refusal as Error).message).toContain(`${WORKSPACE_MAX_DOCUMENTS}`)
    expect(store.saves).toBe(0)
    expect(storedCount(store)).toBe(WORKSPACE_MAX_DOCUMENTS)
  })

  it('takes an update that brings the record exactly to the ceiling', async () => {
    const seed = recordOf(WORKSPACE_MAX_DOCUMENTS - 1)
    const store = new StoredDoc(seed)
    const update = updateFrom(seed, addDocument('last', idOf(WORKSPACE_MAX_DOCUMENTS)))

    const result = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    })

    expect(result.kind).toBe('applied')
    expect(storedCount(store)).toBe(WORKSPACE_MAX_DOCUMENTS)
  })

  // A record already past the ceiling (written before it, or merged from two
  // keepers) must stay editable, and removing documents is how it shrinks.
  it('takes an edit to a record already past the ceiling when the edit adds no document', async () => {
    const seed = recordOf(WORKSPACE_MAX_DOCUMENTS + 1)
    const store = new StoredDoc(seed)
    const update = updateFrom(seed, (doc) => {
      writeMarkdownBody(documentContainers(doc, idOf(0)), 'edited')
      const node = doc
        .getTree(WORKSPACE_TREE_KEY)
        .getNodes()
        .find((candidate) => candidate.data.get('documentId') === idOf(1))
      node?.data.set('segment', 'renamed')
    })

    const result = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    })

    expect(result.kind).toBe('applied')
    expect(storedCount(store)).toBe(WORKSPACE_MAX_DOCUMENTS + 1)
  })
})
