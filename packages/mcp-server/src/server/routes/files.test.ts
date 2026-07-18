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

const purgeDanglingFilesMock = vi.fn()

vi.mock('../store/file-gc.js', async () => {
  const actual = await vi.importActual<typeof import('../store/file-gc.js')>('../store/file-gc.js')
  return {
    ...actual,
    purgeDanglingFiles: (...args: Parameters<typeof actual.purgeDanglingFiles>) =>
      purgeDanglingFilesMock(...args),
  }
})

const withWorkspaceWriteLockMock = vi.fn(async (_workspaceId: string, fn: () => Promise<unknown>) =>
  fn(),
)

vi.mock('../store/workspace-lock.js', async () => {
  const actual = await vi.importActual<typeof import('../store/workspace-lock.js')>(
    '../store/workspace-lock.js',
  )
  return {
    ...actual,
    withWorkspaceWriteLock: (...args: Parameters<typeof actual.withWorkspaceWriteLock>) =>
      withWorkspaceWriteLockMock(...args),
  }
})

const { createFilesRouter } = await import('./files.js')
const { IncompleteFileGcScanError } = await import('../store/file-gc.js')
const { corruptStoredData } = await import('../store/corrupt-stored-data.js')

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

  it('writes the upload inside the per-workspace write lock, the same barrier file-gc holds across its stat+unlink pass', async () => {
    withWorkspaceWriteLockMock.mockClear()
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

    const app = createFilesRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/file/file-001', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: imageData,
    })

    expect(res.status).toBe(204)
    // Without this, a retried upload racing a concurrent GC purge could have
    // its freshly written file deleted between GC's stat() and unlink().
    expect(withWorkspaceWriteLockMock).toHaveBeenCalledWith('session1', expect.any(Function))
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

describe('POST /api/workspaces/:workspaceId/files/purge-dangling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-files-test-'))
    purgeDanglingFilesMock.mockReset()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns a structured 503 when the GC scan is incomplete instead of an unstructured 500', async () => {
    purgeDanglingFilesMock.mockRejectedValue(
      new IncompleteFileGcScanError('session1', [
        { kind: 'branch', slug: 'canvas-a', branch: 'feature', cause: new Error('boom') },
      ]),
    )

    const app = createFilesRouter()
    const res = await app.request('/api/workspaces/session1/files/purge-dangling', {
      method: 'POST',
    })

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: 'incomplete_file_gc_scan',
      message: expect.stringContaining('session1'),
    })
  })

  it('returns a structured 500 corrupt_stored_data when a branch tip is unrecoverably corrupt, not a retryable 503', async () => {
    // A corrupt persisted tipFrontiers can never be fixed by retrying, so
    // it must not be folded into the retryable incomplete-scan (503) path.
    purgeDanglingFilesMock.mockRejectedValue(
      corruptStoredData('session1/canvas-a branch "feature"', 'tipFrontiers could not be decoded'),
    )

    const app = createFilesRouter()
    const res = await app.request('/api/workspaces/session1/files/purge-dangling', {
      method: 'POST',
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('tipFrontiers could not be decoded'),
    })
  })
})
