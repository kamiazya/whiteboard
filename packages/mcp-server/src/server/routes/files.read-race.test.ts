/**
 * A re-upload as another type unlinks the old file, so a GET that listed the
 * directory before the unlink names a file that is gone by the time it reads
 * it. That is a superseded name, not damaged storage: the read lists again
 * and serves the file that replaced it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceFilesDir } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { testFilesRouterOptions, testStoreScope } from './_test-helpers.js'

let tempDir: string
let staleListing: { dir: string; names: string[] } | null = null

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (staleListing === null || String(args[0]) !== staleListing.dir)
        return actual.readdir(...args)
      const { names } = staleListing
      staleListing = null
      return names
    }) as typeof actual.readdir,
  }
})

const { createFilesRouter } = await import('./files.js')

describe('GET of a file replaced between its listing and its read', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-files-race-'))
  })

  afterEach(async () => {
    staleListing = null
    await rm(tempDir, { recursive: true, force: true })
  })

  it('serves the file that replaced the one it listed', async () => {
    const dir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, 'session1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'raced1.webp'), new Uint8Array([0x52, 0x49, 0x46, 0x46]))
    staleListing = { dir, names: ['raced1.png'] }

    const app = createFilesRouter(testFilesRouterOptions(testStoreScope(tempDir)))
    const res = await app.request('/api/w/session1/document/canvas-a/file/raced1')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    expect(staleListing).toBeNull()
  })
})
