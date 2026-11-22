import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frontiersToBase64 } from '@kamiazya/whiteboard-history'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'

// What a version row records of the record it points at, and what reading a
// row whose point cannot be read answers. The stored text is what every
// existing row resolves by, so it is held byte for byte.

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
}))

const { FileVersionStore } = await import('./version-store.js')
const { saveDocument } = await import('./document-store.js')
const { workspaceRecordCopy } = await import('./_test-workspace-record.js')

const WS = '01PAW75F73PVC402Y3V151KT6R'

const canvasOf = (text: string): SpatialCanvas => ({
  nodes: [textNode({ id: 'n', text, x: 0, y: 0, width: 100, height: 40 })],
  edges: [],
})

describe('the point a version row records', () => {
  let store: InstanceType<typeof FileVersionStore>
  let handle: Awaited<ReturnType<typeof import('./db/test-helpers.js').createIsolatedDb>>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'version-frontier-text-'))
    const { createIsolatedDb } = await import('./db/test-helpers.js')
    handle = await createIsolatedDb({ dataDir: tempDir })
    store = new FileVersionStore()
    await saveDocument(WS, 'doc', makeSpatialDoc(canvasOf('one')), { kind: 'spatial' })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  const rowOf = (id: string) =>
    handle.db.selectFrom('versions').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  it('is the record frontiers as the engine encodes them, in base64', async () => {
    const saved = await store.save(WS, 'doc', { auto: false })
    const record = await workspaceRecordCopy(WS)
    expect((await rowOf(saved.id)).frontiers).toBe(
      frontiersToBase64(encodeFrontiers(record.oplogFrontiers())),
    )
  })

  it('records how many nodes the state it names holds, and the digest of its content', async () => {
    const saved = await store.save(WS, 'doc', { auto: false })
    const row = await rowOf(saved.id)
    expect(row.elementCount).toBe(1)
    expect(row.contentDigest).not.toBe('')
  })

  it('is refused as corrupt, naming the row, when the stored text is no frontier', async () => {
    const saved = await store.save(WS, 'doc', { auto: false })
    await handle.db
      .updateTable('versions')
      .set({ frontiers: '!!not-frontiers!!' })
      .where('id', '=', saved.id)
      .execute()
    await expect(store.workspaceVersionFrontiers(WS)).rejects.toThrow(
      new RegExp(`versions/${saved.id}.*could not be decoded`),
    )
  })

  it('is refused as corrupt, naming the row, when its point is not in the record', async () => {
    const saved = await store.save(WS, 'doc', { auto: false })
    const stranger = new LoroDoc()
    stranger.getText('t').insert(0, 'x')
    stranger.commit()
    await handle.db
      .updateTable('versions')
      .set({ frontiers: frontiersToBase64(encodeFrontiers(stranger.oplogFrontiers())) })
      .where('id', '=', saved.id)
      .execute()
    await expect(store.load(WS, saved.id)).rejects.toThrow(
      new RegExp(`versions/${saved.id}.*could not be checked out`),
    )
  })
})
