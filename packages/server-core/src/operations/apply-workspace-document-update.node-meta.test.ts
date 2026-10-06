/**
 * What a workspace-document sync update may write to a tree node's own meta.
 *
 * A node whose meta its schema refuses is skipped by every listing, with
 * everything below it, so the keeper refuses an update that leaves one so —
 * whichever key of the node's map it wrote.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readWorkspaceDocuments,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_NAME_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { DocumentNameTooLongError, UnreadableDocumentMetaError } from './sync-write-refusals.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const PATH = 'notes'
const OTHER_ID = '01BRWAAAAAAAAAAAAAAAAAAAA6'

function workspaceSeed(body: string): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: PATH, documentId: DOC_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, DOC_ID), body)
  doc.commit()
  return doc
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

const storedPathsOf = (store: StoredDoc) =>
  readWorkspaceDocuments(store.get()).map((entry) => entry.path)

/** Writes one key of a document's workspace-node meta as a skewed client could. */
function setNodeMeta(doc: LoroDoc, documentId: string, key: string, value: string): void {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === documentId)
  if (node === undefined) throw new Error(`no node holds ${documentId}`)
  node.data.set(key, value)
}

describe('a workspace-document sync update that writes a node meta', () => {
  const nested = () => {
    const seed = workspaceSeed('body')
    createWorkspaceDocumentAtPath(seed, {
      path: 'notes/child',
      documentId: OTHER_ID,
      kind: 'markdown',
    })
    seed.commit()
    return new StoredDoc(seed)
  }
  const send = (store: StoredDoc, edit: (doc: LoroDoc) => void) =>
    applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update: updateFrom(store.get(), edit),
    })

  it.each([
    ['a kind this keeper does not know', 'kind', 'bogus'],
    ['an empty segment', 'segment', ''],
    ['a creation time that is not a number', 'createdAt', 'x'],
    ['an update time that is not a number', 'updatedAt', 'x'],
  ])('making a readable document unreadable with %s is refused', async (_, key, value) => {
    const store = nested()

    const refusal = await send(store, (doc) => setNodeMeta(doc, DOC_ID, key, value)).catch(
      (err: unknown) => err,
    )

    expect(refusal).toBeInstanceOf(UnreadableDocumentMetaError)
    expect(store.saves).toBe(0)
    // The document and the one below it are both still listed.
    expect(storedPathsOf(store)).toEqual([PATH, 'notes/child'])
  })

  it('a key a folder does not carry, hiding the folder and everything below it, is refused', async () => {
    const seed = workspaceSeed('body')
    createWorkspaceDocumentAtPath(seed, {
      path: 'team/plan',
      documentId: OTHER_ID,
      kind: 'markdown',
    })
    seed.commit()
    const store = new StoredDoc(seed)
    const folder = (doc: LoroDoc) =>
      doc
        .getTree('tree')
        .getNodes()
        .find((node) => node.data.get('segment') === 'team')

    const refusal = await send(store, (doc) => folder(doc)?.data.set('note', 'x')).catch(
      (err: unknown) => err,
    )

    expect(refusal).toBeInstanceOf(UnreadableDocumentMetaError)
    expect(store.saves).toBe(0)
    expect(storedPathsOf(store)).toEqual([PATH, 'team/plan'])
  })

  it('leaving a node already unreadable as it was is applied', async () => {
    const seed = workspaceSeed('body')
    createWorkspaceDocumentAtPath(seed, { path: 'other', documentId: OTHER_ID, kind: 'markdown' })
    setNodeMeta(seed, OTHER_ID, 'kind', 'bogus')
    seed.commit()
    const store = new StoredDoc(seed)

    await expect(
      send(store, (doc) => setNodeMeta(doc, DOC_ID, 'name', 'Renamed')),
    ).resolves.toMatchObject({
      kind: 'applied',
    })
    expect(readWorkspaceDocuments(store.get()).map((entry) => entry.name)).toEqual(['Renamed'])
  })

  it('a name past the length a name may have is refused', async () => {
    const store = nested()
    const name = 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1)

    const refusal = await send(store, (doc) => setNodeMeta(doc, DOC_ID, 'name', name)).catch(
      (err: unknown) => err,
    )

    expect(refusal).toBeInstanceOf(DocumentNameTooLongError)
    expect(store.saves).toBe(0)
  })

  it('a name stored longer before the bound, left or shortened, is applied', async () => {
    const seed = workspaceSeed('body')
    setNodeMeta(seed, DOC_ID, 'name', 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH + 50))
    seed.commit()
    const store = new StoredDoc(seed)

    await expect(
      send(store, (doc) => documentContainers(doc, DOC_ID).getText('body').insert(0, 'more ')),
    ).resolves.toMatchObject({ kind: 'applied' })
    await expect(
      send(store, (doc) =>
        setNodeMeta(doc, DOC_ID, 'name', 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH + 10)),
      ),
    ).resolves.toMatchObject({ kind: 'applied' })
  })

  it('a name stored longer before the bound, left as it was, while another node meta is written, is applied', async () => {
    // A meta write reaches the placement walk, which a body insert never does.
    const seed = workspaceSeed('body')
    setNodeMeta(seed, DOC_ID, 'name', 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH + 50))
    createWorkspaceDocumentAtPath(seed, { path: 'other', documentId: OTHER_ID, kind: 'markdown' })
    seed.commit()
    const store = new StoredDoc(seed)

    await expect(
      send(store, (doc) => setNodeMeta(doc, OTHER_ID, 'name', 'Renamed')),
    ).resolves.toMatchObject({
      kind: 'applied',
    })
  })

  it('a name of exactly DOCUMENT_NAME_MAX_LENGTH is applied', async () => {
    const store = nested()

    await expect(
      send(store, (doc) => setNodeMeta(doc, DOC_ID, 'name', 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH))),
    ).resolves.toMatchObject({ kind: 'applied' })
  })
})
