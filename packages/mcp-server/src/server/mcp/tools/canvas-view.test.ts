import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { DaemonClient } from '../daemon-client.js'
import { canvasViewOutputSchema, canvasViewTool } from './canvas-view.js'

function fakeClientWithElements(elements: Array<Record<string, unknown>>): DaemonClient {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  for (const el of elements) list.push(el)
  const bytes = doc.export({ mode: 'snapshot' })
  return {
    request: async (path: string) => {
      expect(path).toBe('/api/canvas/ws1/slug1/snapshot')
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response
    },
  } as unknown as DaemonClient
}

describe('canvas_view tool', () => {
  it('returns a scene matching the strict {elements} viewer contract', async () => {
    const client = fakeClientWithElements([
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
    ])
    const result = await canvasViewTool().execute({ canvasId: 'ws1/slug1' }, client)
    expect(canvasViewOutputSchema.parse(result)).toEqual(result)
    expect(result.scene.elements).toHaveLength(1)
    expect(result.scene.elements[0]).toMatchObject({ id: 'a', type: 'rectangle' })
  })

  it('drops deleted (tombstoned) elements from the rendered scene', async () => {
    const client = fakeClientWithElements([
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
      { id: 'b', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true },
    ])
    const result = await canvasViewTool().execute({ canvasId: 'ws1/slug1' }, client)
    expect(result.scene.elements.map((e) => e.id)).toEqual(['a'])
  })

  it('never includes daemon credentials or a base URL in its structuredContent', async () => {
    const client = fakeClientWithElements([
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
    ])
    const result = await canvasViewTool().execute({ canvasId: 'ws1/slug1' }, client)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/token|baseUrl|http:\/\/|https:\/\//i)
  })

  it('throws a loud error when the snapshot fetch fails', async () => {
    const client = {
      request: async () => ({ ok: false, status: 404, statusText: 'Not Found' }) as Response,
    } as unknown as DaemonClient
    await expect(canvasViewTool().execute({ canvasId: 'ws1/slug1' }, client)).rejects.toThrow()
  })
})
