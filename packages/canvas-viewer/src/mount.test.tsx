import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => <div data-testid="excalidraw-stub" />,
}))

const { mountCanvasViewer } = await import('./mount.js')

function resetDom() {
  document.body.innerHTML = ''
  // biome-ignore lint/suspicious/noExplicitAny: test-only global reset
  delete (window as any).__WHITEBOARD_VIEWER_SCENE__
}

afterEach(() => {
  resetDom()
})

describe('mountCanvasViewer', () => {
  it('mounts CanvasViewer into the given container using the explicit scene option', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const handle = mountCanvasViewer(container, {
      scene: { elements: [{ id: 'a' }] },
    })

    expect(container.querySelector('[data-testid="canvas-viewer"]')).toBeTruthy()
    handle.dispose()
  })

  it('throws when the scene option fails schema validation', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    expect(() => mountCanvasViewer(container, { scene: { not: 'a scene' } })).toThrow()
  })

  it('falls back to the embedded <script data-whiteboard-scene> when no scene option is given', () => {
    const script = document.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-whiteboard-scene', '')
    script.textContent = JSON.stringify({ elements: [{ id: 'embedded' }] })
    document.head.appendChild(script)

    const container = document.createElement('div')
    document.body.appendChild(container)

    const handle = mountCanvasViewer(container)

    expect(container.querySelector('[data-testid="canvas-viewer"]')).toBeTruthy()
    handle.dispose()
    script.remove()
  })

  it('falls back to window.__WHITEBOARD_VIEWER_SCENE__ when no script tag is present', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only global fixture
    ;(window as any).__WHITEBOARD_VIEWER_SCENE__ = { elements: [{ id: 'window-scene' }] }

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
      scene: { elements: [] },
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
      scene: { elements: [] },
      messageHandler,
    })
    handle.dispose()

    window.dispatchEvent(new MessageEvent('message', { data: { hello: 'again' } }))
    expect(messageHandler).not.toHaveBeenCalled()
  })
})
