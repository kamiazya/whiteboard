import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountCanvasViewer } from './mount.js'

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
})
