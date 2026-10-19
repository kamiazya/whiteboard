/**
 * A sync update whose changes build on a change the keeper does not hold.
 *
 * Loro parks such changes outside the oplog, where no judge reads them, and
 * applies them unjudged once a later import supplies what they build on. So
 * the keeper refuses the update, drops the cached instance holding them, and
 * keeps nothing; the change it builds on is then judged on its own.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedBlobStore } from '../test-utils/unused-blob-store.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { CausalGapError, syncWriteAnswer } from './sync-write-refusals.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

/**
 * One client's two changes to `base`: an edit within every bound, and a run
 * past the limit built on it.
 */
function gappedUpdates(base: LoroDoc, bodyOf: (doc: LoroDoc) => LoroText) {
  const client = base.fork()
  const from = client.oplogVersion()
  bodyOf(client).insert(0, 'gap ')
  client.commit()
  const gap = client.export({ mode: 'update', from })
  const between = client.oplogVersion()
  bodyOf(client).insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
  client.commit()
  return { gap, gapped: client.export({ mode: 'update', from: between }) }
}

describe('a workspace-document sync update that builds on a change the keeper lacks', () => {
  const bodyOf = (doc: LoroDoc) => documentContainers(doc, DOC_ID).getText('body')

  function store(): StoredDoc {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
    writeMarkdownBody(documentContainers(doc, DOC_ID), 'body')
    doc.commit()
    return new StoredDoc(doc)
  }

  function deps(stored: StoredDoc) {
    const workspaceDocuments: WorkspaceDocuments = {
      ...unusedWorkspaceDocuments(),
      get: async () => stored.get(),
      save: async (_workspaceId, doc) => stored.save(doc),
      evict: () => stored.evict(),
      evictProjections: () => {},
    }
    const liveDocuments: LiveDocuments = {
      ...unusedLiveDocuments(),
      withWriteLock: (_workspaceId, fn) => fn(),
    }
    return { liveDocuments, workspaceDocuments, blobStore: unusedBlobStore() }
  }

  it('is refused as a causal gap, and the change it builds on is then judged alone', async () => {
    const stored = store()
    const { gap, gapped } = gappedUpdates(stored.get(), bodyOf)

    const refusal = await applyWorkspaceDocumentUpdate(deps(stored), {
      workspaceId: WS,
      update: gapped,
    }).catch((err: unknown) => err)
    expect(refusal).toBeInstanceOf(CausalGapError)
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'causal_gap', status: 409 })
    expect(stored.saves).toBe(0)

    await expect(
      applyWorkspaceDocumentUpdate(deps(stored), { workspaceId: WS, update: gap }),
    ).resolves.toMatchObject({ kind: 'applied' })
    stored.evict()
    expect(readMarkdownBody(documentContainers(stored.get(), DOC_ID))).toBe('gap body')
  })
})

describe('a per-document sync update that builds on a change the keeper lacks', () => {
  it('is refused as a causal gap, and the change it builds on is then judged alone', async () => {
    const seed = new LoroDoc()
    writeMarkdownBody(seed, 'body')
    seed.commit()
    const stored = new StoredDoc(seed)
    const liveDocuments: LiveDocuments = {
      ...unusedLiveDocuments(),
      withWriteLock: (_workspaceId, fn) => fn(),
      get: async () => stored.get(),
      save: async (_workspaceId, _path, doc) => stored.save(doc),
      evict: () => stored.evict(),
    }
    const { gap, gapped } = gappedUpdates(stored.get(), (doc) => doc.getText('body'))
    const send = (update: Uint8Array) =>
      applyDocumentUpdate({ liveDocuments }, { workspaceId: WS, path: 'notes', update })

    await expect(send(gapped)).rejects.toBeInstanceOf(CausalGapError)
    expect(stored.saves).toBe(0)

    await send(gap)
    stored.evict()
    expect(readMarkdownBody(stored.get())).toBe('gap body')
  })
})
