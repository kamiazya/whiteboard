import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import type { DaemonClient } from '../daemon-client.js'

// Tiny solid-color PNG so tests don't depend on a real asset file.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGUlEQVR4nGP8z8DAwIQDMOEUobiUgQEkAQATDQMR/HpTEgAAAABJRU5ErkJggg==',
  'base64',
)

describe('load_image execute', () => {
  let tmpDir: string | undefined

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  async function writeTinyPng(): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), 'load-image-test-'))
    const imagePath = join(tmpDir, 'tiny.png')
    await writeFile(imagePath, TINY_PNG)
    return imagePath
  }

  it('rejects an unknown canvasId before touching the snapshot/update/file endpoints', async () => {
    const imagePath = await writeTinyPng()
    const { loadImageTool } = await import('./load.js')
    const tool = loadImageTool()
    let touchedWriteEndpoint = false
    const fakeClient: DaemonClient = {
      port: 3099,
      baseUrl: 'http://localhost:3099',
      request: async (path: string) => {
        if (path.endsWith('/exists')) {
          return new Response(JSON.stringify({ exists: false }), { status: 200 })
        }
        touchedWriteEndpoint = true
        throw new Error(`Unexpected request: ${path}`)
      },
      touch: async () => undefined,
    }
    await expect(
      tool.execute({ canvasId: 'unknown-ws/sticky-demo', imagePath }, fakeClient),
    ).rejects.toThrow(/canvas_create/)
    expect(touchedWriteEndpoint).toBe(false)
  })

  it('uploads the image and appends it to the doc when the canvas exists', async () => {
    const imagePath = await writeTinyPng()
    const { loadImageTool } = await import('./load.js')
    const tool = loadImageTool()

    const emptyDoc = new LoroDoc()
    const snapshot = emptyDoc.export({ mode: 'snapshot' })
    let uploadedBody: unknown
    let postedUpdate: Uint8Array | null = null

    const fakeClient: DaemonClient = {
      port: 3099,
      baseUrl: 'http://localhost:3099',
      request: async (path: string, init?: RequestInit) => {
        if (path.endsWith('/exists')) {
          return new Response(JSON.stringify({ exists: true }), { status: 200 })
        }
        if (path.endsWith('/snapshot')) {
          return new Response(snapshot, { status: 200 })
        }
        if (path.includes('/file/')) {
          uploadedBody = init?.body
          return new Response(null, { status: 204 })
        }
        if (path.endsWith('/update')) {
          postedUpdate = init?.body as Uint8Array
          return new Response(null, { status: 204 })
        }
        throw new Error(`Unexpected request: ${path}`)
      },
      touch: async () => undefined,
    }

    const res = await tool.execute({ canvasId: 'sid/slug', imagePath }, fakeClient)
    expect(res.elementId).toBeDefined()
    expect(uploadedBody).toBeDefined()
    expect(postedUpdate).not.toBeNull()
  })
})
