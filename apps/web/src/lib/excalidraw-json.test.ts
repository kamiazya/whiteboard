import { describe, expect, it } from 'vitest'
import { serializeSceneAsExcalidrawJson } from './excalidraw-json.js'

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
})
