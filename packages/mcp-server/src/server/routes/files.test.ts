import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createFilesRouter } = await import('./files.js')

describe('PUT /api/canvas/:workspaceId/:slug/file/:fileId', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-files-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saves image binary data and returns 204', async () => {
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic bytes

    const app = createFilesRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/file/file-001', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: imageData,
    })
    expect(res.status).toBe(204)

    // Confirm the file was written.
    const { readFile } = await import('node:fs/promises')
    const saved = await readFile(join(tempDir, 'session1', 'files', 'file-001.png'))
    expect(saved[0]).toBe(0x89) // PNG magic
  })
})

describe('GET /api/canvas/:workspaceId/:slug/file/:fileId', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-files-test-'))
    await mkdir(join(tempDir, 'session1', 'files'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns a saved image with its MIME type', async () => {
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tempDir, 'session1', 'files', 'file-001.png'), imageData)

    const app = createFilesRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/file/file-001')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('image/png')

    const buf = await res.arrayBuffer()
    expect(new Uint8Array(buf)[0]).toBe(0x89)
  })

  it('returns 404 for a missing fileId', async () => {
    const app = createFilesRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/file/nonexistent')
    expect(res.status).toBe(404)
  })

  it('returns 404 when the files directory does not exist yet', async () => {
    await rm(join(tempDir, 'session1', 'files'), { recursive: true, force: true })

    const app = createFilesRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/file/file-001')

    expect(res.status).toBe(404)
  })

  it('returns structured 500 when the files path is corrupt instead of a directory', async () => {
    await rm(join(tempDir, 'session1', 'files'), { recursive: true, force: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tempDir, 'session1', 'files'), 'not-a-directory')

    const app = createFilesRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/file/file-001')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining(join('session1', 'files')),
    })
  })

  it('returns structured 500 when readFile fails for the matched path', async () => {
    await mkdir(join(tempDir, 'session1', 'files', 'file-001.png'), { recursive: true })

    const app = createFilesRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/file/file-001')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('file-001.png'),
    })
  })

  it('does not return a different file that only shares the same prefix', async () => {
    // When both 'file-001' and 'file-001-extra' exist, requesting 'file-001'
    // must return only the exact match 'file-001.png'.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tempDir, 'session1', 'files', 'file-001.png'), new Uint8Array([0x01]))
    await writeFile(
      join(tempDir, 'session1', 'files', 'file-001-extra.png'),
      new Uint8Array([0x02]),
    )

    const app = createFilesRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/file/file-001')
    expect(res.status).toBe(200)

    const buf = await res.arrayBuffer()
    // The response must contain the bytes from file-001.png (0x01).
    expect(new Uint8Array(buf)[0]).toBe(0x01)
  })

  it('returns 400 for invalid workspaceId / fileId', async () => {
    const app = createFilesRouter()

    const badSession = await app.request('/api/canvas/bad.sid/canvas-a/file/file-001')
    expect(badSession.status).toBe(400)

    const badFileId = await app.request('/api/canvas/session1/canvas-a/file/bad.id')
    expect(badFileId.status).toBe(400)
  })
})
