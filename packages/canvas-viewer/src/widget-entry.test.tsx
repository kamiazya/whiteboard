import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseViewerScene } from './scene.js'

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
    // A test that fails mid-flight with fake timers active would otherwise
    // leak them into the next case.
    vi.useRealTimers()
  })

  it('mounts the initial scene from ui/notifications/tool-result when embedded in a host', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    expect(fakeAppInstances).toHaveLength(1)
    // canvas_view's outputSchema wraps the scene as {canvasId, scene}; only
    // the `scene` field is a valid mountCanvasViewer payload.
    const scene = { elements: [{ id: 'a' }] }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ scene }),
    )
    // mount.js itself is mocked above (constructing a real Excalidraw root
    // in jsdom is out of scope here), so re-run the argument through the
    // real, unmocked scene parser — the same one mountCanvasViewer would
    // apply — to guarantee this is a value parseViewerScene actually
    // accepts, not just a value the mock happened to receive. This is what
    // catches passing the whole {canvasId, scene} wrapper: viewerSceneSchema
    // is .strict() and would reject the extra `canvasId`/`scene` keys.
    const call = vi.mocked(mountCanvasViewer).mock.calls[0]?.[1]
    expect(() => parseViewerScene(call?.scene)).not.toThrow()
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

  it('does not mount a fallback when the host connects but never sends a tool-result', async () => {
    // A host that completes the ext-apps handshake but does not support (or
    // has not yet sent) ui/notifications/tool-result — a plausible
    // real-world host-integration gap for a new SEP-1865 bridge, distinct
    // from "no host at all" and "connect() never resolves" above.
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    expect(fakeAppInstances).toHaveLength(1)
    const { mountCanvasViewer } = await import('./mount.js')
    // bootstrap() must not fall back to the embedded-scene mount here: doing
    // so would risk a second React root racing whatever ontoolresult mounts
    // if the host answers late (see the next test).
    expect(mountCanvasViewer).not.toHaveBeenCalled()
  })

  it('disposes the timeout fallback mount when the host answers late with a tool-result', async () => {
    vi.useFakeTimers()
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(() => new Promise(() => {})) // never resolves within the test

    await importFreshWidgetEntry()
    await vi.advanceTimersByTimeAsync(2_100) // past HOST_CONNECT_TIMEOUT_MS

    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenCalledTimes(1)
    const fallbackHandle = vi.mocked(mountCanvasViewer).mock.results[0]?.value

    // The host's connect() attempt was never cancelled by the timeout, so a
    // tool-result notification can still arrive afterward.
    const scene = { elements: [{ id: 'b' }] }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    expect(mountCanvasViewer).toHaveBeenCalledTimes(2)
    expect(mountCanvasViewer).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ scene }),
    )
    expect(fallbackHandle.dispose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('keeps the current view when a tool-result carries a malformed scene', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = { elements: [{ id: 'a' }] }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })
    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenCalledTimes(1)
    const liveHandle = vi.mocked(mountCanvasViewer).mock.results[0]?.value

    // remount disposes BEFORE mounting, so an unvalidated malformed payload
    // would trade the working view for an empty container.
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { scene: { bogus: true } } })
    fakeAppInstances[0].ontoolresult?.({ structuredContent: {} })

    expect(mountCanvasViewer).toHaveBeenCalledTimes(1)
    expect(liveHandle.dispose).not.toHaveBeenCalled()
  })

  it('does not stack an embedded-scene fallback over a scene the host mounted before the timeout', async () => {
    vi.useFakeTimers()
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(() => new Promise(() => {})) // never resolves

    await importFreshWidgetEntry()
    // Host delivers the tool-result while connect() is still pending, i.e.
    // before the HOST_CONNECT_TIMEOUT_MS branch decides "not connected".
    const scene = { elements: [{ id: 'c' }] }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    await vi.advanceTimersByTimeAsync(2_100)

    const { mountCanvasViewer } = await import('./mount.js')
    // Exactly the host-scene mount — no bare fallback mount stacked on top.
    expect(mountCanvasViewer).toHaveBeenCalledTimes(1)
    expect(mountCanvasViewer).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ scene }),
    )
    const hostHandle = vi.mocked(mountCanvasViewer).mock.results[0]?.value
    expect(hostHandle.dispose).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
