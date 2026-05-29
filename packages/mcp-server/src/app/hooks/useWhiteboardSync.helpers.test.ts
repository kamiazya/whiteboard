import { describe, it, expect, vi } from 'vitest'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExportRequestMessage } from '../../shared/ws-messages.js'
import {
  applyRestoreComplete,
  buildWhiteboardWsProtocols,
  flushPendingExportRequests,
  handleIncomingExportRequest,
} from './useWhiteboardSync.helpers.js'

function makeExportRequest(requestId: string): ExportRequestMessage {
  return { type: 'export_request', requestId }
}

// Build minimal test elements with only frameId and the required fields.
// Real ExcalidrawElement objects require many more properties, so cast through unknown.
function makeElement(partial: {
  id: string
  type: string
  frameId: string | null
  fontSize?: number
}): ExcalidrawElement {
  return partial as unknown as ExcalidrawElement
}

describe('applyRestoreComplete', () => {
  it('closes the restore overlay and always clears local undo', () => {
    const setRestoreInProgress = vi.fn()
    const setRestoreLabel = vi.fn()
    const clearLocalUndo = vi.fn()

    applyRestoreComplete({
      setRestoreInProgress,
      setRestoreLabel,
      clearLocalUndo,
    })

    expect(setRestoreInProgress).toHaveBeenCalledWith(false)
    expect(setRestoreLabel).toHaveBeenCalledWith(null)
    expect(clearLocalUndo).toHaveBeenCalledTimes(1)
  })
})

describe('buildWhiteboardWsProtocols', () => {
  it('offers the daemon token via websocket subprotocol when available', () => {
    expect(buildWhiteboardWsProtocols('secret')).toEqual([
      'excalidraw-v1',
      'daemon-token.secret',
    ])
  })

  it('still offers the base protocol in compatibility mode', () => {
    expect(buildWhiteboardWsProtocols(null)).toEqual(['excalidraw-v1'])
    expect(buildWhiteboardWsProtocols(undefined)).toEqual(['excalidraw-v1'])
  })
})

describe('pending export requests', () => {
  it('queues export_request when the API is not ready instead of dropping it', async () => {
    const pending: ExportRequestMessage[] = []
    const send = vi.fn()

    const result = await handleIncomingExportRequest(makeExportRequest('req-1'), {
      api: null,
      pending,
      send,
      exportToBlobFn: vi.fn(),
      blobToBase64Fn: vi.fn(),
    })

    expect(result).toBe('queued')
    expect(pending).toEqual([makeExportRequest('req-1')])
    expect(send).not.toHaveBeenCalled()
  })

  it('flushes queued export_request messages once the API is ready', async () => {
    const pending: ExportRequestMessage[] = [makeExportRequest('req-1'), makeExportRequest('req-2')]
    const send = vi.fn()
    const exportToBlobFn = vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
    const blobToBase64Fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('data:image/png;base64,one')
      .mockResolvedValueOnce('data:image/png;base64,two')
    const api = {
      getSceneElements: vi.fn(() => []),
      getAppState: vi.fn(() => ({})),
      getFiles: vi.fn(() => ({})),
    }

    const flushed = await flushPendingExportRequests({
      api,
      pending,
      send,
      exportToBlobFn,
      blobToBase64Fn,
    })

    expect(flushed).toBe(2)
    expect(pending).toEqual([])
    expect(send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: 'export_response',
        requestId: 'req-1',
        data: 'data:image/png;base64,one',
      }),
    )
    expect(send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: 'export_response',
        requestId: 'req-2',
        data: 'data:image/png;base64,two',
      }),
    )
  })
})

describe('export_request forced theme', () => {
  // The browser path has to honour theme just like the headless path, so a
  // single export_png(theme=dark) call always renders dark regardless of
  // whether the connected client is sitting in light mode.
  it('overrides appState.theme and viewBackgroundColor when theme=dark is set', async () => {
    const elements = [makeElement({ id: 'rect', type: 'rectangle', frameId: null })]
    const api = {
      getSceneElements: vi.fn(() => elements),
      // Simulate a browser client currently sitting in light mode — the
      // exporter must NOT inherit this when the request forces a theme.
      getAppState: vi.fn(() => ({ theme: 'light', viewBackgroundColor: '#ffffff' })),
      getFiles: vi.fn(() => ({})),
    }
    let capturedAppState: Record<string, unknown> | undefined
    const exportToBlobFn = vi.fn(async (args: { appState: Record<string, unknown> }) => {
      capturedAppState = args.appState
      return new Blob(['png'], { type: 'image/png' })
    })

    await handleIncomingExportRequest(
      { type: 'export_request', requestId: 'req-theme', theme: 'dark' },
      {
        api,
        pending: [],
        send: vi.fn(),
        exportToBlobFn,
        blobToBase64Fn: vi.fn(async () => 'x'),
      },
    )

    if (!capturedAppState) throw new Error('exportToBlobFn was not called')
    const appState = capturedAppState
    expect(appState.theme).toBe('dark')
    // Match the headless renderer's default dark background so the two paths
    // produce visually-comparable PNGs for the same canvas.
    expect(appState.viewBackgroundColor).toBe('#121212')
  })

  it('leaves appState.theme alone when no theme is set on the request', async () => {
    const api = {
      getSceneElements: vi.fn(() => []),
      getAppState: vi.fn(() => ({ theme: 'light', viewBackgroundColor: '#abcdef' })),
      getFiles: vi.fn(() => ({})),
    }
    let capturedAppState: Record<string, unknown> | undefined
    const exportToBlobFn = vi.fn(async (args: { appState: Record<string, unknown> }) => {
      capturedAppState = args.appState
      return new Blob(['png'])
    })

    await handleIncomingExportRequest(
      { type: 'export_request', requestId: 'req-no-theme' },
      {
        api,
        pending: [],
        send: vi.fn(),
        exportToBlobFn,
        blobToBase64Fn: vi.fn(async () => 'x'),
      },
    )

    if (!capturedAppState) throw new Error('exportToBlobFn was not called')
    const appState = capturedAppState
    expect(appState.theme).toBe('light')
    expect(appState.viewBackgroundColor).toBe('#abcdef')
  })
})

describe('export_request frameId filtering', () => {
  // frameId limits the export to the frame and its children so large canvases can be exported section by section.
  it('passes only the frame and its children to exportToBlobFn when frameId is set', async () => {
    const elements = [
      makeElement({ id: 'frame-1', type: 'frame', frameId: null }),
      makeElement({ id: 'child-1', type: 'rectangle', frameId: 'frame-1' }),
      makeElement({ id: 'child-2', type: 'text', frameId: 'frame-1', fontSize: 20 }),
      makeElement({ id: 'outside-1', type: 'rectangle', frameId: null }),
      makeElement({ id: 'other-frame-child', type: 'rectangle', frameId: 'frame-2' }),
    ]
    const api = {
      getSceneElements: vi.fn(() => elements),
      getAppState: vi.fn(() => ({})),
      getFiles: vi.fn(() => ({})),
    }
    let captured: readonly ExcalidrawElement[] | null = null
    const exportToBlobFn = vi.fn(async (args: { elements: readonly ExcalidrawElement[] }) => {
      captured = args.elements
      return new Blob(['png'], { type: 'image/png' })
    })
    const blobToBase64Fn = vi.fn(async () => 'data:image/png;base64,xxx')

    await handleIncomingExportRequest(
      { type: 'export_request', requestId: 'req-frame', frameId: 'frame-1' },
      { api, pending: [], send: vi.fn(), exportToBlobFn, blobToBase64Fn },
    )

    expect(captured).not.toBeNull()
    const list: readonly ExcalidrawElement[] = captured ?? []
    expect(list.map((e) => e.id).sort()).toEqual(['child-1', 'child-2', 'frame-1'])
  })

  it('passes all elements when frameId is not set', async () => {
    const elements = [
      makeElement({ id: 'a', type: 'rectangle', frameId: null }),
      makeElement({ id: 'b', type: 'rectangle', frameId: 'frame-1' }),
    ]
    const api = {
      getSceneElements: vi.fn(() => elements),
      getAppState: vi.fn(() => ({})),
      getFiles: vi.fn(() => ({})),
    }
    let captured: readonly ExcalidrawElement[] | null = null
    const exportToBlobFn = vi.fn(async (args: { elements: readonly ExcalidrawElement[] }) => {
      captured = args.elements
      return new Blob(['png'])
    })

    await handleIncomingExportRequest(
      { type: 'export_request', requestId: 'req-all' },
      {
        api,
        pending: [],
        send: vi.fn(),
        exportToBlobFn,
        blobToBase64Fn: vi.fn(async () => 'x'),
      },
    )

    const list: readonly ExcalidrawElement[] = captured ?? []
    expect(list.map((e) => e.id).sort()).toEqual(['a', 'b'])
  })

  it('passes an empty list when frameId points to a missing frame', async () => {
    const elements = [
      makeElement({ id: 'a', type: 'rectangle', frameId: null }),
      makeElement({ id: 'b', type: 'rectangle', frameId: 'frame-1' }),
    ]
    const api = {
      getSceneElements: vi.fn(() => elements),
      getAppState: vi.fn(() => ({})),
      getFiles: vi.fn(() => ({})),
    }
    let captured: readonly ExcalidrawElement[] | null = null
    const exportToBlobFn = vi.fn(async (args: { elements: readonly ExcalidrawElement[] }) => {
      captured = args.elements
      return new Blob(['png'])
    })

    await handleIncomingExportRequest(
      { type: 'export_request', requestId: 'req-missing', frameId: 'frame-does-not-exist' },
      {
        api,
        pending: [],
        send: vi.fn(),
        exportToBlobFn,
        blobToBase64Fn: vi.fn(async () => 'x'),
      },
    )

    const list: readonly ExcalidrawElement[] = captured ?? []
    expect(list).toEqual([])
  })

  it('still applies minFontPx to filtered text elements when frameId is also set', async () => {
    const elements = [
      makeElement({ id: 'frame-1', type: 'frame', frameId: null }),
      makeElement({ id: 'tiny-text', type: 'text', frameId: 'frame-1', fontSize: 6 }),
      makeElement({ id: 'outside-text', type: 'text', frameId: null, fontSize: 6 }),
    ]
    const api = {
      getSceneElements: vi.fn(() => elements),
      getAppState: vi.fn(() => ({})),
      getFiles: vi.fn(() => ({})),
    }
    let captured: readonly ExcalidrawElement[] | null = null
    const exportToBlobFn = vi.fn(async (args: { elements: readonly ExcalidrawElement[] }) => {
      captured = args.elements
      return new Blob(['png'])
    })

    await handleIncomingExportRequest(
      {
        type: 'export_request',
        requestId: 'req-both',
        frameId: 'frame-1',
        minFontPx: 14,
      },
      {
        api,
        pending: [],
        send: vi.fn(),
        exportToBlobFn,
        blobToBase64Fn: vi.fn(async () => 'x'),
      },
    )

    const list: readonly ExcalidrawElement[] = captured ?? []
    const byId = new Map(list.map((e) => [e.id, e]))
    expect([...byId.keys()].sort()).toEqual(['frame-1', 'tiny-text'])
    const tiny = byId.get('tiny-text') as (ExcalidrawElement & { fontSize: number }) | undefined
    expect(tiny?.fontSize).toBe(14)
  })
})
