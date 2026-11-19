import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LayoutRequest } from './layout-worker-protocol.js'

/**
 * The layout worker answers a request whose core trapped (ADR-0054, QR-26c).
 * The module is a script that installs `self.onmessage`, so it is imported
 * once with the things it would load in a worker (the face, the measurer, the
 * layout itself) replaced, and driven by posting it requests.
 */

const render = vi.hoisted(() => ({
  renderCanvasKeyedWith: vi.fn(),
  renderCanvasToSvgWith: vi.fn(),
}))

vi.mock('./spatial/scene-render-core.js', () => render)
vi.mock('@kamiazya/whiteboard-canvas-viewer/font-loading', () => ({
  ensureViewerFontLoaded: async () => 'loaded',
  registerFontBytes: async () => undefined,
}))
vi.mock('@kamiazya/whiteboard-canvas-viewer/measure-text', () => ({
  createBrowserMeasureText: () => () => ({ width: 1, height: 1 }),
}))

const named = (name: string): Error => {
  const err = new Error(`${name} raised by the core`)
  err.name = name
  return err
}

const request = (id: number): LayoutRequest => ({
  type: 'layout',
  id,
  theme: 'light',
  form: 'keyed',
  canvas: { nodes: [], edges: [] },
})

const posted: unknown[] = []
const closed = vi.fn()
const originalOnmessage = self.onmessage

beforeAll(async () => {
  vi.spyOn(self, 'postMessage').mockImplementation(((message: unknown) => {
    posted.push(message)
  }) as typeof self.postMessage)
  // jsdom's `close` closes the window the test runs in.
  vi.spyOn(self, 'close').mockImplementation(closed)
  // lazy-import: the module installs `self.onmessage` on load, so it must follow the spies above
  await import('./layout-worker.js')
})

// The worker module installs `self.onmessage` and the spies replace two more
// globals; the file's cleanup boundary puts all three back.
afterAll(() => {
  self.onmessage = originalOnmessage
  vi.restoreAllMocks()
})

afterEach(() => {
  posted.length = 0
  closed.mockClear()
  render.renderCanvasKeyedWith.mockReset()
})

const send = async (id: number) => {
  const handler = self.onmessage as unknown as (event: { data: unknown }) => Promise<void>
  await handler({ data: request(id) })
}

describe('the layout worker over a core that trapped', () => {
  it('answers that one request as a failure, and the next from the instance the core reset', async () => {
    render.renderCanvasKeyedWith
      .mockImplementationOnce(() => {
        throw named('CoreInstanceTrapped')
      })
      .mockImplementationOnce(() => ({
        keyed: { svg: '<svg/>', rootOpen: '<svg>', groups: [] },
        bounds: { x: 0, y: 0, w: 1, h: 1 },
        scene: { nodes: [] },
        anchors: new Map(),
      }))

    await send(1)
    await send(2)

    expect(posted[0]).toEqual({
      type: 'failed',
      id: 1,
      reason: expect.stringContaining('CoreInstanceTrapped'),
    })
    expect(posted[1]).toMatchObject({ type: 'laid-out-keyed', id: 2 })
    expect(closed).not.toHaveBeenCalled()
  })

  it('answers a core that cannot be reset as a fatal failure, then closes so the pool replaces it', async () => {
    render.renderCanvasKeyedWith.mockImplementation(() => {
      throw named('CoreUnrecoverable')
    })

    await send(3)

    expect(posted).toEqual([
      {
        type: 'failed',
        id: 3,
        reason: expect.stringContaining('CoreUnrecoverable'),
        fatal: true,
      },
    ])
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('does not close for a failure the core did not make fatal', async () => {
    render.renderCanvasKeyedWith.mockImplementation(() => {
      throw new TypeError('a defect')
    })

    await send(4)

    expect(posted).toEqual([{ type: 'failed', id: 4, reason: expect.any(String) }])
    expect(closed).not.toHaveBeenCalled()
  })
})
