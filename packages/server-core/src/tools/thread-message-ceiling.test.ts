/**
 * The per-thread message ceiling as `wb_thread_edit` holds it: a reply that
 * would take one thread past `THREAD_MAX_MESSAGES` is refused by name, with
 * nothing saved, and a thread already past it stays readable.
 */
import {
  writeCommentThread,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { THREAD_MAX_MESSAGES, THREAD_MESSAGES_LIMIT_PHRASE } from '@kamiazya/whiteboard-model'
import { type LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, test, vi } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createThreadEditTool } from './thread-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const target = { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }

function threadOf(messages: number) {
  return (doc: LoroDoc) =>
    writeCommentThread(doc, {
      id: 't1',
      anchor: { kind: 'document' },
      status: 'open',
      messages: Array.from({ length: messages }, (_, m) => ({ id: `t1-m${m + 1}`, body: 'and?' })),
    })
}

async function seeded(seed: (doc: LoroDoc) => void) {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, 'A note.\n')
    seed(doc)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind: 'markdown',
  })
  const saves = vi.spyOn(store, 'saveSnapshot')
  return { deps: makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }), saves }
}

const reply = { op: 'message.add', threadId: 't1', body: 'one more' } as const
const pastMessages = new RegExp(
  `ops\\[1\\] \\(message.add\\).*${THREAD_MAX_MESSAGES + 1} messages, past ${THREAD_MESSAGES_LIMIT_PHRASE}`,
)

describe('wb_thread_edit holds the per-thread message ceiling', () => {
  test('a reply that brings a thread to the ceiling is taken', async () => {
    const { deps } = await seeded(threadOf(THREAD_MAX_MESSAGES - 1))
    const result = await createThreadEditTool(deps).execute({ ...target, ops: [reply] })
    expect(result.threads[0]?.messages).toHaveLength(THREAD_MAX_MESSAGES)
  })

  test('the reply one past it is refused by name, and nothing is saved', async () => {
    const { deps, saves } = await seeded(threadOf(THREAD_MAX_MESSAGES - 1))
    await expect(
      createThreadEditTool(deps).execute({ ...target, ops: [reply, reply] }),
    ).rejects.toThrow(pastMessages)
    expect(saves).not.toHaveBeenCalled()
  })

  // The sync judge counts every stored entry, so the tool must too: a reply
  // judged against the readable messages alone would store the 1001st.
  test('counts a stored message the schema refuses toward the ceiling', async () => {
    const { deps, saves } = await seeded((doc) => {
      threadOf(THREAD_MAX_MESSAGES - 1)(doc)
      const thread = doc.getMap('threads').get('t1')
      const messages = thread instanceof LoroMap ? thread.get('messages') : undefined
      if (messages instanceof LoroMap) messages.set('t1-junk', { body: 42 })
    })
    await expect(createThreadEditTool(deps).execute({ ...target, ops: [reply] })).rejects.toThrow(
      /past the limit of \d+ messages in one comment thread/,
    )
    expect(saves).not.toHaveBeenCalled()
  })

  test('a thread already past it still opens a sibling thread, but takes no reply', async () => {
    const { deps } = await seeded(threadOf(THREAD_MAX_MESSAGES + 2))
    const opened = await createThreadEditTool(deps).execute({
      ...target,
      ops: [{ op: 'thread.add', anchor: { kind: 'document' }, body: 'a new thread' }],
    })
    expect(opened.threads.find((thread) => thread.id === 't1')?.messages).toHaveLength(
      THREAD_MAX_MESSAGES + 2,
    )
    await expect(createThreadEditTool(deps).execute({ ...target, ops: [reply] })).rejects.toThrow(
      /past the limit of \d+ messages in one comment thread/,
    )
  })
})
