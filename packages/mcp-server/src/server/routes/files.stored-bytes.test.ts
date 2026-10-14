/**
 * What the file route answers is exactly the stored bytes. A Node `Buffer` is
 * a VIEW: its backing `ArrayBuffer` can be larger than the file (a zero-length
 * `readFile` answers a 64 KiB `allocUnsafe` pool) or start elsewhere (a
 * pooled slice), so sending `.buffer` would serve unrelated process memory.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testFilesRouterOptions, testStoreScope, withTempDataDir } from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-files-stored-bytes-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// The stored file `view1` reads back as a view into a larger buffer, the
// shape a pooled `Buffer` has; every other path reads the real disk.
const VIEW_BACKING = new Uint8Array([0xde, 0xad, 0x89, 0x50, 0x4e, 0x47, 0xbe, 0xef])
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    readFile: ((...args: Parameters<typeof real.readFile>) =>
      String(args[0]).endsWith('view1.png')
        ? Promise.resolve(Buffer.from(VIEW_BACKING.buffer, 2, 4))
        : real.readFile(...args)) as typeof real.readFile,
  }
})

const { createFilesRouter } = await import('./files.js')

const route = (fileId: string) => `/api/w/ws-sb/document/board/file/${fileId}`

async function plant(name: string, bytes: Uint8Array) {
  const scope = testStoreScope(tmp.dir)
  const dir = scope.layout.workspaceFilesDir('ws-sb')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), bytes)
  return createFilesRouter(testFilesRouterOptions(scope))
}

describe('the bytes the file route serves', () => {
  it('refuses an empty stored file as corrupt instead of serving memory', async () => {
    const app = await plant('empty1.png', new Uint8Array(0))

    const read = await app.request(route('empty1'))
    expect(read.status).toBe(500)
    const body = (await read.json()) as { error: string }
    expect(body.error).toBe('corrupt_stored_data')
  })

  it('serves only the stored bytes of a buffer that views a larger one', async () => {
    const app = await plant('view1.png', new Uint8Array([0]))

    const read = await app.request(route('view1'))
    expect(read.status).toBe(200)
    expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
})
