import { describe, expect, it } from 'vitest'
import { parseViewerScene, serializeSceneAsExcalidrawJson } from './scene.js'

const el = (over: Record<string, unknown>) =>
  ({ id: 'e', type: 'rectangle', x: 0, y: 0, ...over }) as never

describe('serializeSceneAsExcalidrawJson', () => {
  it('wraps the scene in the standard .excalidraw envelope', () => {
    const doc = serializeSceneAsExcalidrawJson(
      [el({ id: 'a' })],
      { gridSize: null, viewBackgroundColor: '#ffffff' },
      {},
    )

    expect(doc).toMatchObject({
      type: 'excalidraw',
      version: 2,
      source: '@kamiazya/whiteboard',
    })
    expect(doc.elements).toHaveLength(1)
  })

  it('drops deleted elements from the exported payload', () => {
    const doc = serializeSceneAsExcalidrawJson(
      [el({ id: 'live' }), el({ id: 'gone', isDeleted: true })],
      { gridSize: null, viewBackgroundColor: '#fff' },
      {},
    )

    expect(doc.elements.map((e) => (e as { id: string }).id)).toEqual(['live'])
  })

  it('carries embedded files through so images survive a round trip', () => {
    const files = {
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,AA',
        created: 1,
      },
    } as never

    const doc = serializeSceneAsExcalidrawJson(
      [el({ id: 'img', type: 'image', fileId: 'file-1' })],
      { gridSize: null, viewBackgroundColor: '#fff' },
      files,
    )

    expect(doc.files).toBe(files)
  })

  it('falls back to a white background when viewBackgroundColor is absent', () => {
    const doc = serializeSceneAsExcalidrawJson([], { gridSize: null } as never, {})

    expect(doc.appState.viewBackgroundColor).toBe('#ffffff')
  })

  it('preserves gridStep and gridModeEnabled, matching cleanAppStateForExport', () => {
    const doc = serializeSceneAsExcalidrawJson(
      [],
      { gridSize: 20, viewBackgroundColor: '#fff', gridStep: 5, gridModeEnabled: true },
      {},
    )

    expect(doc.appState).toEqual({
      gridSize: 20,
      viewBackgroundColor: '#fff',
      gridStep: 5,
      gridModeEnabled: true,
    })
  })

  it('omits gridStep/gridModeEnabled when the caller did not supply them', () => {
    const doc = serializeSceneAsExcalidrawJson(
      [],
      { gridSize: null, viewBackgroundColor: '#fff' },
      {},
    )

    expect(doc.appState).toEqual({ gridSize: null, viewBackgroundColor: '#fff' })
  })

  it('round-trips through the excalidraw envelope Zod schema unchanged', () => {
    const doc = serializeSceneAsExcalidrawJson(
      [el({ id: 'a' })],
      { gridSize: null, viewBackgroundColor: '#ffffff' },
      {},
    )

    const parsed = parseViewerScene(doc)
    expect(parsed.elements).toEqual(doc.elements)
    expect(parsed.appState).toEqual(doc.appState)
    expect(parsed.files).toEqual(doc.files)
  })
})

describe('parseViewerScene', () => {
  it('parses a valid .excalidraw v2 envelope', () => {
    const scene = parseViewerScene({
      type: 'excalidraw',
      version: 2,
      source: 'x',
      elements: [{ id: 'a' }],
      appState: { gridSize: null, viewBackgroundColor: '#fff' },
      files: {},
    })

    expect(scene.elements).toEqual([{ id: 'a' }])
    expect(scene.appState).toEqual({ gridSize: null, viewBackgroundColor: '#fff' })
  })

  it('rejects an unknown type literal', () => {
    expect(() =>
      parseViewerScene({
        type: 'not-excalidraw',
        version: 2,
        source: 'x',
        elements: [],
        appState: { gridSize: null, viewBackgroundColor: '#fff' },
        files: {},
      }),
    ).toThrow()
  })

  it('rejects version 1', () => {
    expect(() =>
      parseViewerScene({
        type: 'excalidraw',
        version: 1,
        source: 'x',
        elements: [],
        appState: { gridSize: null, viewBackgroundColor: '#fff' },
        files: {},
      }),
    ).toThrow()
  })

  it('rejects version 3', () => {
    expect(() =>
      parseViewerScene({
        type: 'excalidraw',
        version: 3,
        source: 'x',
        elements: [],
        appState: { gridSize: null, viewBackgroundColor: '#fff' },
        files: {},
      }),
    ).toThrow()
  })

  it('rejects an envelope missing elements/appState/files and does not fall through to the loose branch', () => {
    expect(() =>
      parseViewerScene({
        type: 'excalidraw',
        version: 2,
        source: 'x',
      }),
    ).toThrow()
  })

  it('parses a standard .excalidraw envelope with grid fields and no files, matching real Excalidraw exports', () => {
    // Mirrors @excalidraw/excalidraw's cleanAppStateForExport, which types
    // every appState field optional and omits `files` entirely when the
    // document has no embedded images.
    const scene = parseViewerScene({
      type: 'excalidraw',
      version: 2,
      source: 'x',
      elements: [{ id: 'a' }],
      appState: { gridSize: 20, gridStep: 5, gridModeEnabled: true },
    })

    expect(scene.appState).toEqual({ gridSize: 20, gridStep: 5, gridModeEnabled: true })
    expect(scene.files).toEqual({})
  })

  it('parses a bare structuredContent payload with only elements', () => {
    const scene = parseViewerScene({ elements: [{ id: 'a' }] })

    expect(scene.elements).toEqual([{ id: 'a' }])
    expect(scene.appState).toEqual({})
    expect(scene.files).toEqual({})
  })

  it('parses a structuredContent payload with elements, appState and files', () => {
    const scene = parseViewerScene({
      elements: [{ id: 'a' }],
      appState: { viewBackgroundColor: '#000' },
      files: { f1: { id: 'f1' } },
    })

    expect(scene.appState).toEqual({ viewBackgroundColor: '#000' })
    expect(scene.files).toEqual({ f1: { id: 'f1' } })
  })

  it('rejects a type-less payload smuggling envelope-marker keys', () => {
    expect(() =>
      parseViewerScene({
        elements: [],
        version: 2,
        source: 'x',
      }),
    ).toThrow()
  })

  it('rejects non-object garbage input', () => {
    expect(() => parseViewerScene('not an object')).toThrow()
    expect(() => parseViewerScene(null)).toThrow()
    expect(() => parseViewerScene(42)).toThrow()
  })
})
