import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendAgentActivity = vi.fn()
const sendViewportRequest = vi.fn()
const getReadyClientCount = vi.fn(() => 1)

vi.mock('./routes/ws.js', () => ({
  sendAgentActivity: (...args: unknown[]) => sendAgentActivity(...args),
  sendViewportRequest: (...args: unknown[]) => sendViewportRequest(...args),
  getReadyClientCount: (...args: unknown[]) => getReadyClientCount(...args),
}))

const { createCanvasClientNotifier } = await import('./canvas-client-notifier.js')

const WORKSPACE_ID = 'ws-1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const PATH = 'diagrams/flow'

function makeIndex(): InMemoryDocumentIndex {
  const index = new InMemoryDocumentIndex()
  index.seed({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, path: PATH, kind: 'spatial' })
  return index
}

const ACTIVITY = {
  workspaceId: WORKSPACE_ID,
  documentId: DOCUMENT_ID,
  touched: { nodes: ['a'], edges: [] },
  summary: 'added 1',
}

describe('createCanvasClientNotifier', () => {
  beforeEach(() => {
    sendAgentActivity.mockClear()
    sendViewportRequest.mockClear()
    getReadyClientCount.mockClear()
    getReadyClientCount.mockReturnValue(1)
  })

  it('routes an activity by the document PATH, which only the index knows', async () => {
    // The WS routes are keyed by workspace + path; a tool only ever has a
    // documentId. Getting this wrong delivers to nobody, silently.
    const notifier = createCanvasClientNotifier(makeIndex())

    notifier.agentActivity(ACTIVITY)
    await vi.waitFor(() => expect(sendAgentActivity).toHaveBeenCalledTimes(1))

    expect(sendAgentActivity).toHaveBeenCalledWith(WORKSPACE_ID, PATH, {
      operator: { kind: 'ai', peerId: expect.stringMatching(/^daemon-/) },
      touched: { nodes: ['a'], edges: [] },
      summary: 'added 1',
    })
  })

  it('says nothing when the workspace does not own the document', async () => {
    const notifier = createCanvasClientNotifier(new InMemoryDocumentIndex())

    notifier.agentActivity(ACTIVITY)
    // Nothing to wait FOR, so wait for the lookup to have settled and assert
    // the absence — a bare synchronous check would pass before the async
    // path resolution had a chance to call anything.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendAgentActivity).not.toHaveBeenCalled()
  })

  it('forwards a viewport request and reports it delivered', async () => {
    const notifier = createCanvasClientNotifier(makeIndex())

    const delivered = await notifier.requestViewport({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'fit',
      elementIds: ['a'],
      animate: true,
    })

    expect(delivered).toBe(true)
    expect(sendViewportRequest).toHaveBeenCalledWith(WORKSPACE_ID, PATH, expect.any(String), {
      mode: 'fit',
      elementIds: ['a'],
      animate: true,
    })
  })

  it('reports not-delivered, and sends nothing, when no client is ready', async () => {
    getReadyClientCount.mockReturnValue(0)
    const notifier = createCanvasClientNotifier(makeIndex())

    const delivered = await notifier.requestViewport({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })

    expect(delivered).toBe(false)
    expect(sendViewportRequest).not.toHaveBeenCalled()
  })

  it('reports not-delivered rather than throwing when the transport fails', async () => {
    // A tool calls this AFTER its write is committed. A throw here would
    // report a failure for an edit that is already on disk.
    sendViewportRequest.mockImplementationOnce(() => {
      throw new Error('socket exploded')
    })
    const notifier = createCanvasClientNotifier(makeIndex())

    await expect(
      notifier.requestViewport({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).resolves.toBe(false)
  })

  it('does not let a failing announcement reject into its caller', async () => {
    sendAgentActivity.mockImplementationOnce(() => {
      throw new Error('socket exploded')
    })
    const notifier = createCanvasClientNotifier(makeIndex())

    expect(() => notifier.agentActivity(ACTIVITY)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
