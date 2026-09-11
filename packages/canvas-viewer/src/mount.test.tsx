import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountCanvasViewer, ViewerSceneError } from './mount.js'

function resetDom() {
  document.body.innerHTML = ''
  document.head.querySelectorAll('script[data-whiteboard-scene]').forEach((el) => {
    el.remove()
  })
  delete (window as { __WHITEBOARD_VIEWER_SCENE__?: unknown }).__WHITEBOARD_VIEWER_SCENE__
}

afterEach(() => {
  resetDom()
})

describe('mountCanvasViewer', () => {
  it('mounts CanvasViewer into the given container using the explicit scene option', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const handle = mountCanvasViewer(container, {
      scene: { nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }] },
    })

    expect(container.querySelector('[data-testid="canvas-viewer"]')).toBeTruthy()
    handle.dispose()
  })

  it('throws a ViewerSceneError when the scene option fails schema validation', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    expect(() => mountCanvasViewer(container, { scene: { nodes: 'not an array' } })).toThrow(
      /json-canvas-schema/,
    )
  })

  it('reports a malformed embedded <script> as a ViewerSceneError, not a bare SyntaxError', () => {
    // The embedded slot is the one input this entrypoint reads that it did
    // not receive as an argument, and a host that serves truncated or
    // hand-edited HTML lands here. Without this it surfaces as a raw
    // SyntaxError, so a caller catching ViewerSceneError — the documented
    // failure of this API — misses the JSON-syntax case entirely.
    const script = document.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-whiteboard-scene', '')
    script.textContent = '{"nodes": ['
    document.head.appendChild(script)

    const container = document.createElement('div')
    document.body.appendChild(container)

    let thrown: unknown
    try {
      mountCanvasViewer(container)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ViewerSceneError)
    expect((thrown as Error).message).toMatch(/^json-syntax: /)
  })

  it('falls back to the embedded <script data-whiteboard-scene> when no scene option is given', () => {
    const script = document.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-whiteboard-scene', '')
    script.textContent = JSON.stringify({ nodes: [] })
    document.head.appendChild(script)

    const container = document.createElement('div')
    document.body.appendChild(container)

    const handle = mountCanvasViewer(container)

    expect(container.querySelector('[data-testid="canvas-viewer"]')).toBeTruthy()
    handle.dispose()
    script.remove()
  })

  it('falls back to window.__WHITEBOARD_VIEWER_SCENE__ when no script tag is present', () => {
    ;(window as { __WHITEBOARD_VIEWER_SCENE__?: unknown }).__WHITEBOARD_VIEWER_SCENE__ = {
      nodes: [],
    }

    const container = document.createElement('div')
    document.body.appendChild(container)

    const handle = mountCanvasViewer(container)

    expect(container.querySelector('[data-testid="canvas-viewer"]')).toBeTruthy()
    handle.dispose()
  })

  it('registers a window message listener that forwards the full MessageEvent to messageHandler', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const messageHandler = vi.fn()

    const handle = mountCanvasViewer(container, {
      scene: { nodes: [] },
      messageHandler,
    })

    window.dispatchEvent(
      new MessageEvent('message', { data: { hello: 'world' }, origin: 'https://host.example' }),
    )
    expect(messageHandler).toHaveBeenCalledTimes(1)
    const receivedEvent = messageHandler.mock.calls[0]?.[0] as MessageEvent
    expect(receivedEvent.data).toEqual({ hello: 'world' })
    expect(receivedEvent.origin).toBe('https://host.example')

    handle.dispose()
  })

  it('unbinds the message listener on dispose', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const messageHandler = vi.fn()

    const handle = mountCanvasViewer(container, {
      scene: { nodes: [] },
      messageHandler,
    })
    handle.dispose()

    window.dispatchEvent(new MessageEvent('message', { data: { hello: 'again' } }))
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('forwards background, so a host can paint the paper the theme names', () => {
    // The widget is the caller that needs it: a scene drawn on a host's own
    // transparent ground is a themed canvas without its paper, which is the
    // one part of a theme no node carries.
    const container = document.createElement('div')
    document.body.appendChild(container)

    const handle = mountCanvasViewer(container, {
      scene: { nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }] },
      background: '#f8fafc',
    })

    expect(container.querySelector('rect[fill="#f8fafc"]')).toBeTruthy()
    handle.dispose()
  })

  it("forwards style, so a host can ask for the document's theme (ADR-0030)", () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const scene = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'a' },
        { id: 'b', type: 'text', x: 300, y: 200, width: 100, height: 40, text: 'b' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
      // What this entry point ACCEPTS is a JSON Canvas document, so a facet
      // arrives under the format's extension key and `parseViewerScene` lifts
      // it to the model's `facets` (ADR-0035). Spelling the model here reads
      // like the theme is simply ignored.
      'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.neon' } } },
    }

    const plain = mountCanvasViewer(container, { scene })
    expect(container.innerHTML).not.toContain('wb-glow')
    plain.dispose()

    const themed = mountCanvasViewer(container, { scene, style: 'document' })
    expect(container.innerHTML).toContain('wb-glow')
    themed.dispose()
  })
})
