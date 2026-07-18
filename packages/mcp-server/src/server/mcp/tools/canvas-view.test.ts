import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../daemon-client.js'

let tempDataDir: string

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDataDir
  },
  getDataDir: () => tempDataDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { canvasViewOutputSchema, canvasViewTool } = await import('./canvas-view.js')

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
  beforeEach(async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), 'whiteboard-canvas-view-test-'))
  })

  afterEach(async () => {
    await rm(tempDataDir, { recursive: true, force: true })
  })

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

  it('embeds the referenced binary as a dataURL for an image element', async () => {
    // load_image stores image bytes on disk at
    // getDataDir()/{workspaceId}/files/{fileId}{ext}; the widget has no
    // daemon access, so canvas_view must inline them into `scene.files`
    // the same way headless-export's buildExportScene does.
    await mkdir(join(tempDataDir, 'ws1', 'files'), { recursive: true })
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await writeFile(join(tempDataDir, 'ws1', 'files', 'file-1.png'), pngBytes)

    const client = fakeClientWithElements([
      { id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'file-1' },
    ])
    const result = await canvasViewTool().execute({ canvasId: 'ws1/slug1' }, client)

    expect(canvasViewOutputSchema.parse(result)).toEqual(result)
    expect(result.scene.files['file-1']).toMatchObject({
      id: 'file-1',
      mimeType: 'image/png',
      dataURL: `data:image/png;base64,${pngBytes.toString('base64')}`,
    })
  })

  it('returns an empty files map when no element references a binary file', async () => {
    const client = fakeClientWithElements([
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
    ])
    const result = await canvasViewTool().execute({ canvasId: 'ws1/slug1' }, client)
    expect(result.scene.files).toEqual({})
  })
})
