/**
 * What one `wb_thread_edit` call costs the serving loop, by how many threads
 * the document holds and how many messages each carries — every message of
 * every thread, resolved ones included, since neither count is bounded and
 * only OPEN threads are.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/thread-edit-cost.mjs [threads:messages ...]
 *
 * Each argument is one row: a markdown document holding `threads` threads,
 * half of them open, each with `messages` messages, edited by one call of 200
 * ops (the most a call takes) that resolve and reopen them in turn. Times are
 * the median of three calls, in milliseconds, each on a freshly seeded store.
 */
import {
  writeCommentThread,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../../../server-core/src/test-utils/fake-document-store.ts'
import { makeTestDeps } from '../../../server-core/src/test-utils/make-test-deps.ts'
import { createThreadEditTool } from '../../../server-core/src/tools/thread-edit.ts'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const rows = (process.argv.length > 2 ? process.argv.slice(2) : ['50:20', '200:50']).map((row) =>
  row.split(':').map(Number),
)

async function seeded(threads, messages) {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, 'A note.\n')
    for (let t = 0; t < threads; t += 1) {
      writeCommentThread(doc, {
        id: `t${t}`,
        anchor: { kind: 'document' },
        status: t % 2 === 0 ? 'open' : 'resolved',
        messages: Array.from({ length: messages }, (_, m) => ({ id: `t${t}-m${m}`, body: 'why?' })),
      })
    }
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind: 'markdown',
  })
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

console.log('threads  messages   ms per call')
for (const [threads, messages] of rows) {
  const ops = Array.from({ length: 200 }, (_, i) => ({
    op: 'thread.resolve',
    threadId: `t${i % threads}`,
    resolved: i % 4 < 2,
  }))
  const times = []
  for (let i = 0; i < 3; i += 1) {
    const deps = await seeded(threads, messages)
    const tool = createThreadEditTool(deps)
    const start = performance.now()
    await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, ops })
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  console.log(
    [
      String(threads).padStart(7),
      String(messages).padStart(10),
      times[1].toFixed(1).padStart(14),
    ].join(''),
  )
}
