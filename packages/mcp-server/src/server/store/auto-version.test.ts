import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  postDocumentEdit,
  resolveTestServerDeps,
  testStoreScope,
  withTempDataDir,
} from '../routes/_test-helpers.js'
import { versionStoreMock } from './test-utils/version-store-mock.js'

const tmp = withTempDataDir('whiteboard-auto-version-test-')

// The deps a router is handed by its root; here, the test wiring over the
// temp data dir (routers no longer compose their own).
let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: '01M8BBN7JS60N0ZAR13NP8SXBF' })
})

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createAutoVersionTrigger } = await import('./auto-version.js')
const { corruptStoredData } = await import('./corrupt-stored-data.js')
const { clearDocCacheForTests } = await import('./doc-cache.js')
const { loadDocument } = await import('./document-store.js')
const { createDocumentRouter } = await import('../routes/document.js')
const wsModule = await import('../sync-audience.js')
const { FileVersionStore } = await import('./version-store.js')

const box = (id: string) => textNode({ id, text: id, x: 0, y: 0, width: 10, height: 10 })

describe('auto-version', () => {
  it('createAutoVersionTrigger is a function', () => {
    expect(typeof createAutoVersionTrigger).toBe('function')
  })
})

describe('createAutoVersionTrigger', () => {
  // One test in this block pins the clock with fake timers; always restore real timers
  // after each test so a failed assertion can't leak a frozen clock into later tests.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves the key uncovered when a save fails, so the next edit retries it', async () => {
    const doc = new LoroDoc()
    const entry = {
      id: 'v1',
      path: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
    }
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient fs error'))
      .mockResolvedValueOnce(entry)
    const trigger = createAutoVersionTrigger(versionStoreMock({ save }), { quietMs: 60_000 })

    // A failed checkpoint must leave the key looking uncovered, or the next
    // edit would be skipped by the diff check and the failure would be
    // permanent for as long as nothing else changed.
    trigger('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a', doc)
    await trigger.flush()
    doc.getMap('m').set('k', 1)
    doc.commit()
    trigger('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a', doc)
    await trigger.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(
      2,
      '01M8BBN7JS60N0ZAR13NP8SXBF',
      'canvas-a',
      doc,
      expect.anything(),
    )
    trigger.stop()
  })

  it('leaves the key uncovered when the save reports corruption', async () => {
    const doc = new LoroDoc()
    const entry = {
      id: 'v2',
      path: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
    }
    const save = vi
      .fn()
      .mockRejectedValueOnce(corruptStoredData('/tmp/versions/v1.json', 'broken metadata'))
      .mockResolvedValueOnce(entry)
    const trigger = createAutoVersionTrigger(versionStoreMock({ save }), { quietMs: 60_000 })

    // A failed checkpoint must leave the key looking uncovered, or the next
    // edit would be skipped by the diff check and the failure would be
    // permanent for as long as nothing else changed.
    trigger('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a', doc)
    await trigger.flush()
    doc.getMap('m').set('k', 1)
    doc.commit()
    trigger('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a', doc)
    await trigger.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(
      2,
      '01M8BBN7JS60N0ZAR13NP8SXBF',
      'canvas-a',
      doc,
      expect.anything(),
    )
    trigger.stop()
  })
})

describe('auto-version corruption handling', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, '01M8BBN7JS60N0ZAR13NP8SXBF'), { recursive: true })
    clearDocCacheForTests()
  })
  afterEach(() => {
    clearDocCacheForTests()
  })

  it('returns 200 and skips version_created when auto-version save reports corruption', async () => {
    const sendVersionCreated = vi
      .spyOn(wsModule, 'sendVersionCreated')
      .mockImplementation(() => undefined)
    const versionStore = versionStoreMock({
      save: vi
        .fn()
        .mockRejectedValue(corruptStoredData('/tmp/versions/v1.json', 'broken metadata')),
    })

    await createTestDocument(serverDeps, {
      workspaceId: '01M8BBN7JS60N0ZAR13NP8SXBF',
      path: 'canvas-a',
    })

    // Quiet immediately: the checkpoint fires on the next tick rather than
    // five minutes out, so the route's own behaviour is what this observes.
    const app = createDocumentRouter({
      scope: testStoreScope(),
      serverDeps,
      mayPlaceDocuments: () => true,
      autoVersionQuietMs: 0,
      versionStore,
    })
    const res = await postDocumentEdit(
      app,
      '01M8BBN7JS60N0ZAR13NP8SXBF',
      'canvas-a',
      (containers) => writeSpatialCanvas(containers, { nodes: [box('e1')], edges: [] }),
    )

    expect(res.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(versionStore.save).toHaveBeenCalledTimes(1)
    expect(sendVersionCreated).not.toHaveBeenCalled()

    clearDocCacheForTests()
    const serverDoc = await loadDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a')
    expect(readSpatialCanvas(serverDoc).nodes.map((node) => node.id)).toEqual(['e1'])
  })
})

/**
 * A checkpoint is a point somebody could come back to, so a second row
 * holding the state the first one already holds is not one — it is noise in
 * the list a person reads.
 *
 * The scheduler's diff check was in-memory only, keyed per process. Every
 * way that memory can be empty or stale while the ROWS say otherwise gives a
 * checkpoint over a document nothing changed in, and a reconnect is the
 * cheapest of them: a client re-sending ops the server already has is a CRDT
 * no-op, and the update route signals the trigger for every document it edits.
 */
describe('an unchanged document', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, '01M8BBN7JS60N0ZAR13NP8SXBF'), { recursive: true })
    clearDocCacheForTests()
  })
  afterEach(() => {
    clearDocCacheForTests()
  })

  it('takes no second checkpoint when the newest version already holds this state', async () => {
    const store = new FileVersionStore()
    // The decision point, observed rather than waited out. "No row appeared"
    // is a claim about something that does not happen, and the only way to
    // wait for that on a clock is to guess how long; counting the question
    // the scheduler asks turns it into a positive one — the keeper WAS
    // consulted, and the list is still what it was.
    let asked = 0
    const askedInner = store.isUnchangedSinceLastVersion.bind(store)
    store.isUnchangedSinceLastVersion = async (workspaceId, path) => {
      asked += 1
      return askedInner(workspaceId, path)
    }
    await createTestDocument(serverDeps, {
      workspaceId: '01M8BBN7JS60N0ZAR13NP8SXBF',
      path: 'canvas-a',
    })

    const first = createDocumentRouter({
      scope: testStoreScope(),
      serverDeps,
      mayPlaceDocuments: () => true,
      autoVersionQuietMs: 0,
      versionStore: store,
    })
    const edited = await postDocumentEdit(
      first,
      '01M8BBN7JS60N0ZAR13NP8SXBF',
      'canvas-a',
      (containers) => writeSpatialCanvas(containers, { nodes: [box('e1')], edges: [] }),
    )
    expect(edited.status).toBe(200)
    await vi.waitFor(async () => {
      expect(await store.list('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a')).toHaveLength(1)
    })

    // A FRESH router, so a fresh trigger with an empty diff check — which is
    // what a daemon restart leaves behind — signalled for the state the
    // newest version already holds.
    const askedBefore = asked
    let restarted: ((workspaceId: string, path: string, doc: LoroDoc) => void) | undefined
    createDocumentRouter({
      scope: testStoreScope(),
      serverDeps,
      mayPlaceDocuments: () => true,
      autoVersionQuietMs: 0,
      versionStore: store,
      onAutoVersionTrigger: (trigger) => {
        restarted = trigger
      },
    })
    restarted?.(
      '01M8BBN7JS60N0ZAR13NP8SXBF',
      'canvas-a',
      await serverDeps.liveDocuments.get('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a'),
    )
    await vi.waitFor(() => {
      expect(asked).toBeGreaterThan(askedBefore)
    })

    expect(await store.list('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a')).toHaveLength(1)
  })
})
