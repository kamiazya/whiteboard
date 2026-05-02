import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

const { saveCanvas, loadCanvas } = await import('./canvas-store.js')
const { purgeDanglingFiles } = await import('./file-gc.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function seedFile(workspaceId: string, fileId: string, ext: string, bytes: number): Promise<void> {
  const dir = join(tempDir, workspaceId, 'files')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${fileId}${ext}`), Buffer.alloc(bytes, 0xab))
}

function makeDocWithImage(fileId: string): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(0, new LoroMap())
  map.set('id', `el-${fileId}`)
  map.set('type', 'image')
  map.set('fileId', fileId)
  map.set('isDeleted', false)
  doc.commit()
  return doc
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-file-gc-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('purgeDanglingFiles', () => {
  it('keeps files referenced by live canvas elements and deletes the rest', async () => {
    // Two canvases reference distinct fileIds; an additional dangling file
    // and a tombstoned-element fileId both qualify for deletion.
    await saveCanvas('ws_a', 'used-a', makeDocWithImage('used-a'))
    await saveCanvas('ws_a', 'used-b', makeDocWithImage('used-b'))

    await seedFile('ws_a', 'used-a', '.png', 100)
    await seedFile('ws_a', 'used-b', '.png', 200)
    await seedFile('ws_a', 'orphan-1', '.png', 1000)
    await seedFile('ws_a', 'orphan-2', '.jpg', 500)

    const result = await purgeDanglingFiles('ws_a')

    expect(result.purgedCount).toBe(2)
    expect(result.purgedBytes).toBe(1500)

    const remaining = (await readdir(join(tempDir, 'ws_a', 'files'))).sort()
    expect(remaining).toEqual(['used-a.png', 'used-b.png'])
  })

  it('treats elements flagged isDeleted=true as not referencing their fileId', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'tombstone')
    map.set('type', 'image')
    map.set('fileId', 'soft-deleted')
    map.set('isDeleted', true)
    doc.commit()
    await saveCanvas('ws_b', 'tombstoned', doc)

    await seedFile('ws_b', 'soft-deleted', '.png', 800)

    const result = await purgeDanglingFiles('ws_b')
    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(800)
  })

  it('returns zero counts for a workspace with no files dir yet', async () => {
    const result = await purgeDanglingFiles('ws_empty')
    expect(result).toEqual({ purgedCount: 0, purgedBytes: 0 })
  })

  it('keeps files referenced by a saved version when versionStore is supplied', async () => {
    // Step 1: live state references "version-only" via an image element.
    await saveCanvas('ws_v', 'evolving', makeDocWithImage('version-only'))
    const store = new FileVersionStore()
    await store.save('ws_v', 'evolving', await loadCanvas('ws_v', 'evolving'), { auto: false })

    // Step 2: live state changes — remove the original element and add a
    // brand-new one. After this commit the live doc has only "live-now",
    // while the saved version still points at "version-only".
    const live = await loadCanvas('ws_v', 'evolving')
    const list = live.getMovableList('elements')
    if (list.length > 0) list.delete(0, list.length)
    const newMap = list.insertContainer(0, new LoroMap())
    newMap.set('id', 'el-live-now')
    newMap.set('type', 'image')
    newMap.set('fileId', 'live-now')
    newMap.set('isDeleted', false)
    live.commit()
    await saveCanvas('ws_v', 'evolving', live, { overwrite: true })

    await seedFile('ws_v', 'version-only', '.png', 700)
    await seedFile('ws_v', 'live-now', '.png', 300)
    await seedFile('ws_v', 'truly-dangling', '.png', 100)

    const result = await purgeDanglingFiles('ws_v', { versionStore: store })
    // Only "truly-dangling" gets dropped — the version-only reference is
    // protected by walking past versions.
    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(100)

    const remaining = (await readdir(join(tempDir, 'ws_v', 'files'))).sort()
    expect(remaining).toEqual(['live-now.png', 'version-only.png'])
  })
})
