/**
 * The per-document open-thread and open-change ceilings on a document's sync
 * writes, which carry Loro bytes no tool op reads: the same bound is judged
 * against what the bytes do, and a refused write keeps nothing.
 */
import {
  readAnnotations,
  readProposals,
  setCommentThreadStatus,
  writeCommentThread,
  writeProposal,
} from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_MAX_OPEN_CHANGES, DOCUMENT_MAX_OPEN_THREADS } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'
import { syncWriteAnswer } from './sync-write-refusals.js'

const openThread = (doc: LoroDoc, id: string) =>
  writeCommentThread(doc, {
    id,
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: `${id}-m1`, body: 'is this right?' }],
  })

function documentWith(threads: number): LoroDoc {
  const doc = new LoroDoc()
  for (let i = 0; i < threads; i += 1) openThread(doc, `t${i}`)
  return doc
}

function send(store: StoredDoc, edit: (doc: LoroDoc) => void) {
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
    get: async () => store.get(),
    save: async (_workspaceId, _path, doc) => store.save(doc),
    evict: () => store.evict(),
  }
  const client = store.get().fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return applyDocumentUpdate(
    { liveDocuments },
    { workspaceId: 'ws-1', path: 'doc', update: client.export({ mode: 'update', from }) },
  )
}

describe('a document sync update', () => {
  it('opening a thread past the ceiling is refused, 413, and nothing is kept', async () => {
    const store = new StoredDoc(documentWith(DOCUMENT_MAX_OPEN_THREADS))

    const refusal = await send(store, (doc) => openThread(doc, 'extra')).catch(
      (err: unknown) => err,
    )

    expect(syncWriteAnswer(refusal)).toEqual({ code: 'too_many_open_threads', status: 413 })
    expect(store.saves).toBe(0)
    expect(readAnnotations(store.get())).toHaveLength(DOCUMENT_MAX_OPEN_THREADS)
  })

  it('resolving one and opening another is applied', async () => {
    const store = new StoredDoc(documentWith(DOCUMENT_MAX_OPEN_THREADS))

    await send(store, (doc) => {
      setCommentThreadStatus(doc, 't0', 'resolved')
      openThread(doc, 'extra')
    })

    expect(readAnnotations(store.get()).map((thread) => thread.id)).toContain('extra')
  })

  it('a proposal past the open-change ceiling is refused, 413, and nothing is kept', async () => {
    const doc = new LoroDoc()
    const change = (id: string) => ({
      id,
      status: 'open' as const,
      op: 'node.add' as const,
      node: textNode({ id: `n-${id}`, x: 0, y: 0, width: 100, height: 40, text: 'x' }),
    })
    writeProposal(doc, {
      id: 'p1',
      changes: Array.from({ length: DOCUMENT_MAX_OPEN_CHANGES }, (_, i) => change(`c${i}`)),
    })
    const store = new StoredDoc(doc)

    const refusal = await send(store, (client) =>
      writeProposal(client, { id: 'p2', changes: [change('extra')] }),
    ).catch((err: unknown) => err)

    expect(syncWriteAnswer(refusal)).toEqual({ code: 'too_many_open_changes', status: 413 })
    expect(store.saves).toBe(0)
    expect(readProposals(store.get()).map((proposal) => proposal.id)).toEqual(['p1'])
  })
})
