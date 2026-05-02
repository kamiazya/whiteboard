import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

const { loadCanvasFiles } = await import('./load-canvas-files.js')

async function seedFile(workspaceId: string, fileId: string, ext: string, bytes: number): Promise<void> {
  const dir = join(tempDir, workspaceId, 'files')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${fileId}${ext}`), Buffer.alloc(bytes, 0xab))
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'load-canvas-files-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('loadCanvasFiles selective loading', () => {
  it('returns an empty map when the workspace has no files dir yet', async () => {
    const out = await loadCanvasFiles('ws_empty', new Set())
    expect(out).toEqual({})
  })

  it('only loads files whose id appears in the referenced-id set', async () => {
    // Three files exist; only two are referenced by the canvas being
    // exported. The third is a leftover from another canvas in the same
    // workspace and must NOT inflate the export payload.
    await seedFile('ws_a', 'used-1', '.png', 100)
    await seedFile('ws_a', 'used-2', '.jpg', 200)
    await seedFile('ws_a', 'unrelated', '.png', 999)

    const out = await loadCanvasFiles('ws_a', new Set(['used-1', 'used-2']))
    expect(Object.keys(out).sort()).toEqual(['used-1', 'used-2'])
    expect(out['used-1'].mimeType).toBe('image/png')
    expect(out['used-2'].mimeType).toBe('image/jpeg')
    // The unrelated file must be entirely absent from the result.
    expect(out['unrelated']).toBeUndefined()
  })

  it('returns {} when the referenced set is empty even if files exist on disk', async () => {
    await seedFile('ws_b', 'orphan', '.png', 50)
    const out = await loadCanvasFiles('ws_b', new Set())
    expect(out).toEqual({})
  })

  it('skips a referenced file that vanished between scan and read instead of failing the export', async () => {
    // Reference an id that is not on disk — simulates the GC race where a
    // file is deleted between elements computing the set and readFile()
    // being called. Old behaviour walked the whole directory and would
    // throw ENOENT only if the entry it had already enumerated vanished;
    // the new selective path checks for ENOENT explicitly so the entire
    // export does not abort on one missing attachment.
    await seedFile('ws_c', 'real', '.png', 50)
    const out = await loadCanvasFiles('ws_c', new Set(['real', 'phantom']))
    expect(Object.keys(out)).toEqual(['real'])
  })

  it('honours every supported MIME extension from the lookup table', async () => {
    await seedFile('ws_mime', 'a', '.png', 1)
    await seedFile('ws_mime', 'b', '.jpg', 1)
    await seedFile('ws_mime', 'c', '.jpeg', 1)
    await seedFile('ws_mime', 'd', '.gif', 1)
    await seedFile('ws_mime', 'e', '.webp', 1)
    await seedFile('ws_mime', 'f', '.svg', 1)

    const out = await loadCanvasFiles(
      'ws_mime',
      new Set(['a', 'b', 'c', 'd', 'e', 'f']),
    )
    expect(out['a'].mimeType).toBe('image/png')
    expect(out['b'].mimeType).toBe('image/jpeg')
    expect(out['c'].mimeType).toBe('image/jpeg')
    expect(out['d'].mimeType).toBe('image/gif')
    expect(out['e'].mimeType).toBe('image/webp')
    expect(out['f'].mimeType).toBe('image/svg+xml')
  })
})
