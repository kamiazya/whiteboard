import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceFilesDir } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'

/**
 * How many times the history plane decodes the WHOLE workspace record.
 *
 * A record is every document of a workspace in one Loro document, so one
 * decode costs the workspace, not the document a call is about. A history
 * read that decodes once per document checkpointed, per GET, or per version
 * walked multiplies that by the history's own size — K edited documents, V
 * versions — under the workspace write lock or on a read route.
 *
 * Counted rather than timed: a decode is a stored-snapshot read of the
 * workspace record, a `LoroDoc.fromSnapshot`, or a `fork` (each copies the
 * whole record). The number is the same on every machine.
 */

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { newImageRef } = await import('@kamiazya/whiteboard-model')
const { writeSpatialCanvas } = await import('@kamiazya/whiteboard-loro-adapter')
const { loadDocument, saveDocument } = await import('./document-store.js')
const { purgeDanglingFiles } = await import('./file-gc.js')
const { FileVersionStore } = await import('./version-store.js')
const { createAutoVersionTrigger } = await import('./auto-version.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { makeSpatialDoc } = await import('../../shared/test-utils/spatial-doc.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-history-decodes-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** Starts counting whole-record decodes; read `.count` after the act. */
function countRecordDecodes() {
  const stored = vi.spyOn(LibsqlDocumentStore.prototype, 'loadSnapshot')
  const fromSnapshot = vi.spyOn(LoroDoc, 'fromSnapshot')
  const fork = vi.spyOn(LoroDoc.prototype, 'fork')
  const checkout = vi.spyOn(LoroDoc.prototype, 'checkout')
  return {
    /** Stored snapshot reads of the workspace record. */
    get storedReads(): number {
      return stored.mock.calls.filter(([input]) => input.docRef.kind === 'workspace-tree').length
    },
    /** In-memory copies of a decoded record. */
    get copies(): number {
      return fromSnapshot.mock.calls.length + fork.mock.calls.length
    },
    get count(): number {
      return this.storedReads + this.copies
    },
    get checkouts(): number {
      return checkout.mock.calls.length
    },
  }
}

function canvasReferencing(prefix: string, nodes: number): SpatialCanvas {
  return {
    nodes: Array.from({ length: nodes }, (_unused, i) =>
      fileNode({
        id: `node-${i}`,
        file: newImageRef(`${prefix}-${i}`),
        x: i * 10,
        y: i * 10,
        width: 100,
        height: 100,
      }),
    ),
    edges: [],
  }
}

const DOCUMENTS = 6
const VERSIONS_EACH = 4

/** DOCUMENTS documents, each with VERSIONS_EACH versions at distinct points. */
async function seedHistory(
  workspaceId: string,
  store: InstanceType<typeof FileVersionStore>,
): Promise<string[]> {
  const paths: string[] = []
  for (let d = 0; d < DOCUMENTS; d++) {
    const path = `page-${d}`
    paths.push(path)
    await saveDocument(workspaceId, path, makeSpatialDoc(canvasReferencing(`d${d}`, 3)))
    for (let v = 0; v < VERSIONS_EACH; v++) {
      const doc = await loadDocument(workspaceId, path)
      await store.save(workspaceId, path, doc, { auto: false, label: `v${v}` })
      writeSpatialCanvas(doc, canvasReferencing(`d${d}v${v}`, 3))
      await saveDocument(workspaceId, path, doc, { overwrite: true })
    }
  }
  return paths
}

describe('whole-record decodes on the history plane', () => {
  it('a batch of automatic checkpoints decodes the record at most once', async () => {
    const store = new FileVersionStore()
    const paths: string[] = []
    for (let d = 0; d < DOCUMENTS; d++) {
      paths.push(`page-${d}`)
      await saveDocument('ws_cp', `page-${d}`, makeSpatialDoc(canvasReferencing(`d${d}`, 3)))
    }
    const trigger = createAutoVersionTrigger(store, { quietMs: 60_000 })
    for (const path of paths) trigger('ws_cp', path, await loadDocument('ws_cp', path))

    const decodes = countRecordDecodes()
    await trigger.flush()
    const counted = decodes.count

    // Every checkpoint landed, so the count covers real work.
    for (const path of paths) expect(await store.list('ws_cp', path)).toHaveLength(1)
    expect(counted).toBeLessThanOrEqual(1)
  })

  it('listing and previewing versions decodes the record O(1) per GET', async () => {
    const store = new FileVersionStore()
    const [path] = await seedHistory('ws_read', store)
    const ids = (await store.list('ws_read', path as string)).map((v) => v.id)
    expect(ids).toHaveLength(VERSIONS_EACH)

    const decodes = countRecordDecodes()
    for (let i = 0; i < 5; i++) await store.list('ws_read', path as string)
    expect(decodes.count, 'five lists').toBe(0)

    // A preview is one checkout of one copy of the record — never a stored
    // read on top, and never a snapshot round trip.
    await store.load('ws_read', ids[0] as string)
    expect(decodes.count, 'one preview').toBeLessThanOrEqual(1)
  })

  it('a file-GC pass copies the record once, not once per version', async () => {
    const store = new FileVersionStore()
    await seedHistory('ws_gc', store)
    const dir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, 'ws_gc')
    await mkdir(dir, { recursive: true })
    const orphan = join(dir, 'orphan.png')
    await writeFile(orphan, Buffer.alloc(16, 0xab))
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await utimes(orphan, past, past)

    const decodes = countRecordDecodes()
    const result = await purgeDanglingFiles('ws_gc', { versionStore: store })

    // The pass reached the unlink, so the scan it counts really ran.
    expect(result).toMatchObject({ purgedCount: 1 })
    // One copy to check versions out on. The two stored reads are the pass
    // judging against the RECORD, before the scan and in the fence after it
    // (`catchUpWorkspaceDoc`) — per pass, whatever the history holds.
    expect(decodes.copies).toBeLessThanOrEqual(1)
    expect(decodes.storedReads).toBeLessThanOrEqual(2)
    // Each distinct point is checked out once at most.
    expect(decodes.checkouts).toBeLessThanOrEqual(DOCUMENTS * VERSIONS_EACH)
  })

  it('a GC pass checks out a point many versions share only once', async () => {
    const store = new FileVersionStore()
    for (let d = 0; d < DOCUMENTS; d++) {
      await saveDocument('ws_same', `page-${d}`, makeSpatialDoc(canvasReferencing(`d${d}`, 3)))
    }
    // No edit between the saves, so every version names one frontier.
    for (let d = 0; d < DOCUMENTS; d++) {
      const doc = await loadDocument('ws_same', `page-${d}`)
      await store.save('ws_same', `page-${d}`, doc, { auto: false, label: 'same point' })
    }
    const dir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, 'ws_same')
    await mkdir(dir, { recursive: true })
    const orphan = join(dir, 'orphan.png')
    await writeFile(orphan, Buffer.alloc(16, 0xab))
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await utimes(orphan, past, past)

    const decodes = countRecordDecodes()
    const result = await purgeDanglingFiles('ws_same', { versionStore: store })

    expect(result).toMatchObject({ purgedCount: 1 })
    expect(decodes.checkouts).toBe(1)
  })
})
