import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// widget-entry.ts bootstraps immediately on import (`void bootstrap()`), so
// each test needs a fresh module instance + fresh DOM to observe one
// bootstrap in isolation.

interface FakeAppInstance {
  ontoolresult?: (result: unknown) => void
  connect: () => Promise<void>
}

const connectMock = vi.fn()
const fakeAppInstances: FakeAppInstance[] = []

vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: vi.fn(function FakeApp(this: FakeAppInstance) {
    fakeAppInstances.push(this)
    this.connect = connectMock
  }),
}))

vi.mock('./mount.js', () => ({
  mountCanvasViewer: vi.fn(() => ({ dispose: vi.fn() })),
}))

function stubEmbeddedIframeParent(): void {
  // window.parent === window by default in jsdom (top-level document). A
  // real MCP Apps host embeds the widget in an iframe, so window.parent
  // differs from window — simulate that so mountFromHost attempts to
  // connect instead of short-circuiting to the no-host fallback.
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: {},
  })
}

async function importFreshWidgetEntry() {
  vi.resetModules()
  return import('./widget-entry.js')
}

// jsdom implements neither the FontFace constructor nor document.fonts —
// registerFonts() (unrelated to this bridge bootstrap, but run
// unconditionally by the same bootstrap()) needs both to exist so it does
// not throw before the bridge logic under test ever runs.
class FakeFontFace {
  constructor(
    public family: string,
    public source: string,
  ) {}
  load(): Promise<FakeFontFace> {
    return Promise.resolve(this)
  }
}

describe('widget-entry MCP Apps bridge bootstrap', () => {
  beforeEach(async () => {
    document.body.innerHTML = '<div id="root"></div>'
    fakeAppInstances.length = 0
    connectMock.mockReset()
    // The mount.js mock module instance persists across vi.resetModules()
    // calls (only the real module graph is reset), so its call history
    // must be cleared explicitly between tests.
    const { mountCanvasViewer } = await import('./mount.js')
    vi.mocked(mountCanvasViewer).mockClear()
    // biome-ignore lint/suspicious/noExplicitAny: jsdom test shim for a browser-only API
    ;(globalThis as any).FontFace = FakeFontFace
    if (!document.fonts) {
      Object.defineProperty(document, 'fonts', { configurable: true, value: { add() {} } })
    }
  })

  afterEach(() => {
    // Restore window.parent so subsequent tests default back to top-level.
    Object.defineProperty(window, 'parent', { configurable: true, value: window })
  })

  it('mounts the initial scene from ui/notifications/tool-result when embedded in a host', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    expect(fakeAppInstances).toHaveLength(1)
    const scene = { elements: [{ id: 'a' }] }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ scene: { canvasId: 'ws/slug', scene } }),
    )
  })

  it('falls back to the embedded-scene slot when there is no parent frame', async () => {
    // Default jsdom top-level document: window.parent === window.
    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    expect(fakeAppInstances).toHaveLength(0)
    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenLastCalledWith(expect.any(HTMLElement))
  })

  it('falls back to the embedded-scene slot when host connect() never resolves', async () => {
    vi.useFakeTimers()
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(() => new Promise(() => {})) // never resolves

    await importFreshWidgetEntry()
    await vi.advanceTimersByTimeAsync(2_100)

    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenLastCalledWith(expect.any(HTMLElement))
    vi.useRealTimers()
  })
})
