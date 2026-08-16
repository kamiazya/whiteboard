import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseViewerScene } from './scene.js'

// widget-entry.ts bootstraps immediately on import (`void bootstrap()`), so
// each test needs a fresh module instance + fresh DOM to observe one
// bootstrap in isolation.

interface FakeAppInstance {
  ontoolresult?: (result: unknown) => void
  connect: () => Promise<void>
  callServerTool: (params: unknown) => Promise<unknown>
  getHostCapabilities: () => { serverTools?: Record<string, unknown> } | undefined
}

const connectMock = vi.fn()
const callServerToolMock = vi.fn()
const fakeAppInstances: FakeAppInstance[] = []
// Real hosts advertise this via the ext-apps handshake; defaulting to
// "supported" here keeps the existing Refresh-flow tests focused on the
// connect()/tool-result behavior they exist to cover. Tests for the
// capability gate itself override this per-case.
let getHostCapabilitiesMock: FakeAppInstance['getHostCapabilities'] = () => ({ serverTools: {} })

vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: vi.fn(function FakeApp(this: FakeAppInstance) {
    fakeAppInstances.push(this)
    this.connect = connectMock
    this.callServerTool = callServerToolMock
    this.getHostCapabilities = () => getHostCapabilitiesMock()
  }),
}))

const REFRESH_SELECTOR = '[data-testid="widget-refresh"]'
const STICKY_FORM_SELECTOR = '[data-testid="widget-sticky-note"]'

function queryRefreshButton(): HTMLButtonElement | null {
  return document.querySelector(REFRESH_SELECTOR)
}

function queryStickyForm(): HTMLFormElement | null {
  return document.querySelector(STICKY_FORM_SELECTOR)
}

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
    callServerToolMock.mockReset()
    getHostCapabilitiesMock = () => ({ serverTools: {} })
    // The mount.js mock module instance persists across vi.resetModules()
    // calls (only the real module graph is reset), so its call history
    // must be cleared explicitly between tests.
    const { mountCanvasViewer } = await import('./mount.js')
    vi.mocked(mountCanvasViewer).mockClear()
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
    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ scene }),
    )
    // mount.js itself is mocked above (constructing a real viewer root in
    // jsdom is out of scope here), so re-run the argument through the real,
    // unmocked scene parser — the same one mountCanvasViewer would apply —
    // to guarantee this is a value parseViewerScene actually accepts, not
    // just a value the mock happened to receive.
    const call = vi.mocked(mountCanvasViewer).mock.calls[0]?.[1]
    expect(parseViewerScene(call?.scene).ok).toBe(true)
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
    const scene = {
      nodes: [{ id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
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

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })
    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenCalledTimes(1)
    const liveHandle = vi.mocked(mountCanvasViewer).mock.results[0]?.value

    // remount disposes BEFORE mounting, so an unvalidated malformed payload
    // would trade the working view for an empty container.
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { scene: { nodes: 'not an array' } } })
    fakeAppInstances[0].ontoolresult?.({ structuredContent: {} })
    // Malformed ENVELOPES (not just malformed scenes): the Zod envelope
    // parse must degrade to "no scene" for shapes the cast-based extractor
    // would have crashed on or mis-read — never throw, never remount.
    fakeAppInstances[0].ontoolresult?.(null)
    fakeAppInstances[0].ontoolresult?.('not an object')
    fakeAppInstances[0].ontoolresult?.({ structuredContent: 42 })
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 123, scene } })

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
    const scene = {
      nodes: [{ id: 'c', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
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

  it('has no Refresh control when there is no parent frame', async () => {
    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    expect(queryRefreshButton()).toBeNull()
  })

  it('has no Refresh control when host connect() times out', async () => {
    vi.useFakeTimers()
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(() => new Promise(() => {})) // never resolves

    await importFreshWidgetEntry()
    await vi.advanceTimersByTimeAsync(2_100)

    expect(queryRefreshButton()).toBeNull()
    vi.useRealTimers()
  })

  it('never reveals Refresh when the host does not advertise the serverTools capability', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)
    getHostCapabilitiesMock = () => ({})

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    // A committed canvasId would normally reveal Refresh (see the next
    // test); the missing serverTools capability must suppress that.
    expect(queryRefreshButton()).toBeNull()
  })

  it('reveals Refresh immediately when a tool-result commits a canvasId before the connect() race settles', async () => {
    stubEmbeddedIframeParent()
    let resolveConnect: (() => void) | undefined
    connectMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve
        }),
    )

    await importFreshWidgetEntry()
    // The tool-result fires synchronously right after import, before
    // connect() has resolved — committedCanvasId is already set when
    // connect() (and thus the `if (connected)` branch) resolves next.
    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    resolveConnect?.()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // This is the `if (committedCanvasId !== undefined) refreshControl.show()`
    // branch reflected in widget-entry.ts, not rememberCanvasId's own
    // `refreshControl?.show()` call (the control did not exist yet when the
    // tool-result arrived).
    const button = queryRefreshButton()
    expect(button).not.toBeNull()
    expect(button?.style.display).toBe('block')
  })

  it("forwards canvas_view's references to the viewer so a file node can show its document", async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)
    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = {
      nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 320, height: 220, file: 'notes' }],
    }
    const body = { type: 'root', children: [{ type: 'paragraph', children: [] }] }
    fakeAppInstances[0].ontoolresult?.({
      structuredContent: {
        canvasId: 'ws/slug',
        scene,
        references: { notes: { label: 'W', body } },
      },
    })

    const { mountCanvasViewer } = await import('./mount.js')
    expect(mountCanvasViewer).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ references: { notes: { label: 'W', body } } }),
    )
  })

  it('drops a reference whose body is not real mdast, keeping the rest of the payload', async () => {
    // The host is not trusted: `references` is parsed against the canonical
    // mdastRootSchema. A root-shaped body with an undispatchable child would
    // otherwise reach layout, where one bad child aborts the whole canvas.
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)
    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = {
      nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 320, height: 220, file: 'notes' }],
    }
    fakeAppInstances[0].ontoolresult?.({
      structuredContent: {
        canvasId: 'ws/slug',
        scene,
        references: { notes: { body: { type: 'root', children: [null] } } },
      },
    })

    const { mountCanvasViewer } = await import('./mount.js')
    const opts = vi.mocked(mountCanvasViewer).mock.calls.at(-1)?.[1]
    // The scene still mounted; only the unparseable references were dropped.
    expect(opts?.scene).toEqual(scene)
    expect(opts?.references).toBeUndefined()
  })

  it('never mounts the sticky-note control, since the tool behind it no longer exists', async () => {
    // Not "absence of something that never existed": the control DID ship,
    // and was unwired because every submission failed at the host with an
    // unknown-tool error while the control still looked live (see the
    // TODO(annotate) note in widget-entry.ts). Re-mounting it without
    // restoring a backing tool turns this red.
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })
    await Promise.resolve()
    await Promise.resolve()

    expect(queryStickyForm()).toBeNull()
    // Refresh IS still wired, so this cannot pass merely because bootstrap
    // fell over and mounted no controls at all.
    expect(queryRefreshButton()).not.toBeNull()
  })

  it('reveals Refresh only after connecting AND a valid tool-result commits a canvasId', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    // Connected, but no tool-result yet: control is either absent or hidden.
    const beforeResult = queryRefreshButton()
    if (beforeResult) {
      expect(beforeResult.style.display).toBe('none')
    }

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    const button = queryRefreshButton()
    expect(button).not.toBeNull()
    expect(button?.style.display).toBe('block')
  })

  it('keeps Refresh absent when a tool-result mounts before the timeout wins the connect race, even after a late connect resolution or further late results', async () => {
    vi.useFakeTimers()
    stubEmbeddedIframeParent()
    let resolveConnect: (() => void) | undefined
    connectMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve
        }),
    )

    await importFreshWidgetEntry()
    const scene = {
      nodes: [{ id: 'c', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    await vi.advanceTimersByTimeAsync(2_100)
    expect(queryRefreshButton()).toBeNull()

    resolveConnect?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(queryRefreshButton()).toBeNull()

    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })
    expect(queryRefreshButton()).toBeNull()

    vi.useRealTimers()
  })

  it('never commits canvasId or reveals Refresh from a tool-result carrying a malformed scene', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    fakeAppInstances[0].ontoolresult?.({
      structuredContent: { canvasId: 'wrong', scene: { nodes: 'not an array' } },
    })
    // Connected already, so the control exists but must stay hidden — it is
    // not absent from the DOM, just never revealed by an unvalidated result.
    const hiddenButton = queryRefreshButton()
    if (hiddenButton) {
      expect(hiddenButton.style.display).toBe('none')
    }

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/right', scene } })
    expect(queryRefreshButton()?.style.display).toBe('block')
  })

  it('clicking Refresh calls callServerTool with the committed canvasId and remounts on a valid result', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene1 = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({
      structuredContent: { canvasId: 'ws/slug', scene: scene1 },
    })

    const { mountCanvasViewer } = await import('./mount.js')
    const initialHandle = vi.mocked(mountCanvasViewer).mock.results[0]?.value
    vi.mocked(mountCanvasViewer).mockClear()

    const scene2 = {
      nodes: [{ id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    callServerToolMock.mockResolvedValueOnce({
      structuredContent: { canvasId: 'ws/slug', scene: scene2 },
    })

    const button = queryRefreshButton()
    button?.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(callServerToolMock).toHaveBeenCalledTimes(1)
    expect(callServerToolMock).toHaveBeenCalledWith({
      name: 'canvas_view',
      arguments: { canvasId: 'ws/slug' },
    })
    expect(initialHandle.dispose).toHaveBeenCalledTimes(1)
    expect(mountCanvasViewer).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ scene: scene2 }),
    )
  })

  it('keeps the current view and resets the in-flight guard when callServerTool rejects', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    const { mountCanvasViewer } = await import('./mount.js')
    vi.mocked(mountCanvasViewer).mockClear()

    callServerToolMock.mockRejectedValueOnce(new Error('boom'))
    const button = queryRefreshButton() as HTMLButtonElement
    button.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mountCanvasViewer).not.toHaveBeenCalled()
    expect(button.disabled).toBe(false)

    const scene2 = {
      nodes: [{ id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    callServerToolMock.mockResolvedValueOnce({
      structuredContent: { canvasId: 'ws/slug', scene: scene2 },
    })
    button.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(callServerToolMock).toHaveBeenCalledTimes(2)
    expect(mountCanvasViewer).toHaveBeenCalledTimes(1)
  })

  it('keeps the current view and resets the guard when callServerTool resolves with a malformed scene', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    const { mountCanvasViewer } = await import('./mount.js')
    vi.mocked(mountCanvasViewer).mockClear()

    callServerToolMock.mockResolvedValueOnce({
      structuredContent: { canvasId: 'ws/slug', scene: { nodes: 'not an array' } },
    })
    const button = queryRefreshButton() as HTMLButtonElement
    button.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mountCanvasViewer).not.toHaveBeenCalled()
    expect(button.disabled).toBe(false)

    const scene2 = {
      nodes: [{ id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    callServerToolMock.mockResolvedValueOnce({
      structuredContent: { canvasId: 'ws/slug', scene: scene2 },
    })
    button.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(callServerToolMock).toHaveBeenCalledTimes(2)
    expect(mountCanvasViewer).toHaveBeenCalledTimes(1)
  })

  it('ignores a re-entrant click while a refresh is already in flight', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    let resolveCall: ((value: unknown) => void) | undefined
    callServerToolMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve
        }),
    )

    const button = queryRefreshButton() as HTMLButtonElement
    button.click()
    button.click()
    button.click()
    await Promise.resolve()

    expect(callServerToolMock).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)

    resolveCall?.({ structuredContent: { canvasId: 'ws/slug', scene: { nodes: [] } } })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(button.disabled).toBe(false)
  })

  it('tolerates a host-echoed ontoolresult duplicate after a successful refresh', async () => {
    stubEmbeddedIframeParent()
    connectMock.mockImplementation(async () => undefined)

    await importFreshWidgetEntry()
    await Promise.resolve()
    await Promise.resolve()

    const scene = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    fakeAppInstances[0].ontoolresult?.({ structuredContent: { canvasId: 'ws/slug', scene } })

    const { mountCanvasViewer } = await import('./mount.js')
    vi.mocked(mountCanvasViewer).mockClear()

    const scene2 = {
      nodes: [{ id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
    }
    callServerToolMock.mockResolvedValueOnce({
      structuredContent: { canvasId: 'ws/slug', scene: scene2 },
    })
    const button = queryRefreshButton() as HTMLButtonElement
    button.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mountCanvasViewer).toHaveBeenCalledTimes(1)

    // Host also echoes the refreshed result via its normal notification path.
    expect(() =>
      fakeAppInstances[0].ontoolresult?.({
        structuredContent: { canvasId: 'ws/slug', scene: scene2 },
      }),
    ).not.toThrow()
    expect(mountCanvasViewer).toHaveBeenCalledTimes(2)
  })
})

describe('widget-entry append-only invariant', () => {
  it('only calls callServerTool with tool names from the append-only allowlist', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { dirname, resolve: resolvePath } = await import('node:path')
    const { fileURLToPath } = await import('node:url')

    const here = dirname(fileURLToPath(import.meta.url))
    const widgetDir = resolvePath(here, 'widget')
    const sources = [
      readFileSync(resolvePath(here, 'widget-entry.ts'), 'utf-8'),
      ...readdirSync(widgetDir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
        .map((f) => readFileSync(resolvePath(widgetDir, f), 'utf-8')),
    ].join('\n')

    // `annotate` was removed from this allowlist when its affordance was
    // unwired (see the TODO(annotate) note in widget-entry.ts): the tool no
    // longer exists server-side, so a call site naming it is a call that
    // fails at the host. Restoring the affordance means widening this
    // deliberately, not by accident.
    const allowlist = new Set(['canvas_view'])
    const callSiteNames = [...sources.matchAll(/callServerTool\(\s*\{\s*name:\s*'([^']+)'/g)].map(
      (m) => m[1],
    )

    expect(callSiteNames.length).toBeGreaterThan(0)
    for (const name of callSiteNames) {
      expect(allowlist.has(name as string), `unexpected callServerTool name: ${name}`).toBe(true)
    }
  })
})
