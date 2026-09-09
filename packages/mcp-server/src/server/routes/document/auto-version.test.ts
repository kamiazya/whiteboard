import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-auto-version-test-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { AUTO_VERSION_CEILING_MS, AUTO_VERSION_QUIET_MS, createAutoVersionTrigger } = await import(
  './auto-version.js'
)
const { corruptStoredData } = await import('../../store/corrupt-stored-data.js')
const { clearCache } = await import('../../store/doc-cache.js')
const { loadDocument } = await import('../../store/document-store.js')
const { createDocumentRouter } = await import('../document.js')
const wsModule = await import('../ws.js')
const { FileVersionStore } = await import('../../store/version-store.js')

describe('auto-version', () => {
  it('exports a quiet period, and a ceiling longer than it', () => {
    expect(AUTO_VERSION_QUIET_MS).toBeGreaterThan(0)
    // The ceiling only means anything if editing can plausibly run past a
    // pause without reaching it.
    expect(AUTO_VERSION_CEILING_MS).toBeGreaterThan(AUTO_VERSION_QUIET_MS)
  })

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
    const trigger = createAutoVersionTrigger(
      {
        save,
        load: vi.fn(),
        list: vi.fn(),
        saveThumbnail: vi.fn(),
        loadThumbnail: vi.fn(),
        getFrontiersBase64: vi.fn(),
      },
      { quietMs: 60_000 },
    )

    // A failed checkpoint must leave the key looking uncovered, or the next
    // edit would be skipped by the diff check and the failure would be
    // permanent for as long as nothing else changed.
    trigger('session1', 'canvas-a', doc)
    await trigger.flush()
    doc.getMap('m').set('k', 1)
    doc.commit()
    trigger('session1', 'canvas-a', doc)
    await trigger.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(2, 'session1', 'canvas-a', doc, expect.anything())
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
      branchName: 'main',
    }
    const save = vi
      .fn()
      .mockRejectedValueOnce(corruptStoredData('/tmp/versions/v1.json', 'broken metadata'))
      .mockResolvedValueOnce(entry)
    const trigger = createAutoVersionTrigger(
      {
        save,
        load: vi.fn(),
        list: vi.fn(),
        saveThumbnail: vi.fn(),
        loadThumbnail: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      { quietMs: 60_000 },
    )

    // A failed checkpoint must leave the key looking uncovered, or the next
    // edit would be skipped by the diff check and the failure would be
    // permanent for as long as nothing else changed.
    trigger('session1', 'canvas-a', doc)
    await trigger.flush()
    doc.getMap('m').set('k', 1)
    doc.commit()
    trigger('session1', 'canvas-a', doc)
    await trigger.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(2, 'session1', 'canvas-a', doc, expect.anything())
    trigger.stop()
  })
})

describe('auto-version corruption handling', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
    clearCache()
  })
  afterEach(() => {
    clearCache()
  })

  it('returns 200 and skips version_created when auto-version save reports corruption', async () => {
    const sendVersionCreated = vi
      .spyOn(wsModule, 'sendVersionCreated')
      .mockImplementation(() => undefined)
    const versionStore = {
      save: vi
        .fn()
        .mockRejectedValue(corruptStoredData('/tmp/versions/v1.json', 'broken metadata')),
      load: vi.fn(),
      list: vi.fn(),
      saveThumbnail: vi.fn(),
      loadThumbnail: vi.fn(),
      getFrontiersBase64: vi.fn(),
      renameBranchInVersions: vi.fn(),
    }

    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'e1')
    map.set('type', 'rectangle')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    // Quiet immediately: the checkpoint fires on the next tick rather than
    // five minutes out, so the route's own behaviour is what this observes.
    const app = createDocumentRouter({
      autoVersionQuietMs: 0,
      versionStore,
    })
    const res = await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })

    expect(res.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(versionStore.save).toHaveBeenCalledTimes(1)
    expect(sendVersionCreated).not.toHaveBeenCalled()

    clearCache()
    const serverDoc = await loadDocument('session1', 'canvas-a')
    const elements = serverDoc.getMovableList('elements').toJSON() as Array<{ id: string }>
    expect(elements.map((entry) => entry.id)).toEqual(['e1'])
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
 * no-op, and the update route signals the trigger on every POST regardless.
 */
describe('an unchanged document', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
    clearCache()
  })
  afterEach(() => {
    clearCache()
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
    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const map = clientDoc.getMovableList('elements').insertContainer(0, new LoroMap())
    map.set('id', 'e1')
    map.set('type', 'rectangle')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    const post = async (app: { request: (...args: never[]) => Promise<Response> }) =>
      (app.request as unknown as (url: string, init: RequestInit) => Promise<Response>)(
        '/api/w/session1/document/canvas-a/update',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: update,
        },
      )

    const first = createDocumentRouter({ autoVersionQuietMs: 0, versionStore: store })
    expect((await post(first)).status).toBe(200)
    await vi.waitFor(async () => {
      expect(await store.list('session1', 'canvas-a')).toHaveLength(1)
    })

    // A FRESH router, so a fresh trigger with an empty diff check — which is
    // what a daemon restart leaves behind. The same bytes again: a
    // reconnecting client replaying ops the record already carries.
    const askedBefore = asked
    const second = createDocumentRouter({ autoVersionQuietMs: 0, versionStore: store })
    expect((await post(second)).status).toBe(200)
    await vi.waitFor(() => {
      expect(asked).toBeGreaterThan(askedBefore)
    })

    expect(await store.list('session1', 'canvas-a')).toHaveLength(1)
  })
})
