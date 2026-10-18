import { DOCUMENT_MAX_OPEN_THREADS } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'

// lazy-import: the module under test is imported after `vi.mock` replaces the
// thread counter, so the counter it calls is the one this file counts.
const counted = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./comment-threads.js', async (original) => {
  const actual = await original<typeof import('./comment-threads.js')>()
  return {
    ...actual,
    openThreadCount: (...args: Parameters<typeof actual.openThreadCount>) => {
      counted.calls += 1
      return actual.openThreadCount(...args)
    },
  }
})

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

/**
 * An update that opens one thread container per thread it writes must not
 * recount the document once per container: that was quadratic in the thread
 * count (1000 threads judged in 12 s), and the judgement is paid before the
 * ceiling can refuse the update.
 */
describe('the open-thread bound counts a document once per update', () => {
  it('counts the threads once however many thread containers the update writes', async () => {
    const { writeThreadInto } = await import('./comment-threads.js')
    const { importWithinTextLimits } = await import('./sync-text-limits.js')
    const { createWorkspaceDocumentAtPath, documentContainers } = await import(
      './workspace-tree.js'
    )
    const record = new LoroDoc()
    record.setPeerId(2n)
    createWorkspaceDocumentAtPath(record, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
    const board = documentContainers(record, DOC_ID)
    const threads = DOCUMENT_MAX_OPEN_THREADS
    for (let i = 0; i < threads; i += 1) {
      writeThreadInto(board, {
        id: `t${i}`,
        anchor: { kind: 'document' },
        status: 'open',
        messages: [{ id: `t${i}-m1`, body: 'hello' }],
      })
    }
    record.commit()

    counted.calls = 0
    const { breach } = importWithinTextLimits(new LoroDoc(), record.export({ mode: 'snapshot' }))

    expect(breach).toBeNull()
    expect(counted.calls).toBeGreaterThan(0)
    expect(counted.calls).toBeLessThanOrEqual(2)
  })
})
