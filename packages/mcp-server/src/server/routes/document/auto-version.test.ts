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
      hasThumbnail: false,
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

  it('passes branchName to save when getHeadBranch is injected', async () => {
    const doc = new LoroDoc()
    const entry = {
      id: 'v1',
      path: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
      hasThumbnail: false,
      branchName: 'feature',
    }
    const save = vi.fn().mockResolvedValue(entry)
    const getHeadBranch = vi
      .fn<(sid: string, path: string) => Promise<string | null>>()
      .mockResolvedValue('feature')
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
      { quietMs: 60_000, getHeadBranch },
    )
    trigger('session1', 'canvas-a', doc)
    await trigger.flush()
    expect(getHeadBranch).toHaveBeenCalledWith('session1', 'canvas-a')
    expect(save).toHaveBeenCalledWith('session1', 'canvas-a', doc, {
      auto: true,
      branchName: 'feature',
      operator: {
        kind: 'system',
        peerId: doc.peerIdStr,
        displayName: 'auto-save',
      },
    })
  })

  it('calls save without branchName when getHeadBranch returns null', async () => {
    const doc = new LoroDoc()
    const save = vi.fn().mockResolvedValue({
      id: 'v1',
      path: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
      hasThumbnail: false,
      branchName: 'main',
    })
    const getHeadBranch = vi.fn().mockResolvedValue(null)
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
      { quietMs: 60_000, getHeadBranch },
    )
    trigger('session1', 'canvas-a', doc)
    await trigger.flush()
    expect(save).toHaveBeenCalledWith('session1', 'canvas-a', doc, {
      auto: true,
      operator: {
        kind: 'system',
        peerId: doc.peerIdStr,
        displayName: 'auto-save',
      },
    })
  })

  it('does not silently fall back to save when getHeadBranch throws corruption', async () => {
    const doc = new LoroDoc()
    const save = vi.fn()
    const getHeadBranch = vi
      .fn<(sid: string, path: string) => Promise<string | null>>()
      .mockRejectedValue(corruptStoredData('/tmp/branches.json', 'broken branch state'))
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
      { quietMs: 60_000, getHeadBranch },
    )

    // Corruption reading the head branch must not be swallowed into a save
    // with the wrong branch on it. The trigger has no caller to reject to any
    // more, so what the case pins is that no version is written at all.
    trigger('session1', 'canvas-a', doc)
    await trigger.flush()
    expect(save).not.toHaveBeenCalled()
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
      hasThumbnail: false,
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
