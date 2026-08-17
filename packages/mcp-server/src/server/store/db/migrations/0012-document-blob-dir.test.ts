import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const { migration } = await import('./0012-document-blob-dir.js')

const OLD_SEGMENT = 'canvas'
const NEW_SEGMENT = 'document'

async function seedBlob(workspaceId: string, segment: string, name: string, body: string) {
  const dir = join(dataDir, 'blobs', workspaceId, segment)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), body)
}

async function listBlobDir(workspaceId: string, segment: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, 'blobs', workspaceId, segment))).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-blob-dir-'))
})

describe('0012-document-blob-dir', () => {
  it('moves every workspace‚Äôs blobs to the new segment, contents intact', async () => {
    // Two workspaces, because the walk is per-workspace: a migration that
    // only moved the first would leave the rest unreadable, and the store has
    // exactly one path to read them by.
    await seedBlob('ws-1', OLD_SEGMENT, 'doc-a.loro', 'a-bytes')
    await seedBlob('ws-2', OLD_SEGMENT, 'doc-b.loro', 'b-bytes')

    await migration.up(undefined as never)

    expect(await listBlobDir('ws-1', NEW_SEGMENT)).toEqual(['doc-a.loro'])
    expect(await listBlobDir('ws-2', NEW_SEGMENT)).toEqual(['doc-b.loro'])
    expect(await listBlobDir('ws-1', OLD_SEGMENT)).toEqual([])
    expect(await readFile(join(dataDir, 'blobs', 'ws-1', NEW_SEGMENT, 'doc-a.loro'), 'utf-8')).toBe(
      'a-bytes',
    )
  })

  it('leaves a workspace‚Äôs other blob subdirectories alone', async () => {
    // `files/` holds uploaded attachments and is swept by a different owner
    // (file-gc-sweeper). A migration that renamed the whole workspace
    // directory, or moved more than the one segment, would take those with it.
    await seedBlob('ws-1', OLD_SEGMENT, 'doc-a.loro', 'a-bytes')
    await seedBlob('ws-1', 'files', 'upload.png', 'png-bytes')

    await migration.up(undefined as never)

    expect(await listBlobDir('ws-1', 'files')).toEqual(['upload.png'])
  })

  it('is a no-op for a workspace that has no blobs yet', async () => {
    // A fresh install migrates before anything is written, and a workspace
    // created through the index need never have stored a document.
    await mkdir(join(dataDir, 'blobs', 'ws-empty'), { recursive: true })

    await expect(migration.up(undefined as never)).resolves.toBeUndefined()

    expect(await listBlobDir('ws-empty', NEW_SEGMENT)).toEqual([])
  })

  it('is a no-op when the blobs root does not exist at all', async () => {
    // The migrator runs at boot, before the store has created anything.
    await expect(migration.up(undefined as never)).resolves.toBeUndefined()
  })

  it('down moves the blobs back', async () => {
    await seedBlob('ws-1', OLD_SEGMENT, 'doc-a.loro', 'a-bytes')
    await migration.up(undefined as never)

    await migration.down(undefined as never)

    expect(await listBlobDir('ws-1', OLD_SEGMENT)).toEqual(['doc-a.loro'])
    expect(await listBlobDir('ws-1', NEW_SEGMENT)).toEqual([])
  })
})
