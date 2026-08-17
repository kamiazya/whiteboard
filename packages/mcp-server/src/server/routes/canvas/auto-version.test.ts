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

const { AUTO_VERSION_INTERVAL_MS, createAutoVersionTrigger } = await import('./auto-version.js')
const { corruptStoredData } = await import('../../store/corrupt-stored-data.js')
const { clearCache } = await import('../../store/doc-cache.js')
const { loadDocument } = await import('../../store/document-store.js')
const { createCanvasRouter } = await import('../canvas.js')
const wsModule = await import('../ws.js')

describe('auto-version', () => {
  it('exports a positive interval constant', () => {
    expect(AUTO_VERSION_INTERVAL_MS).toBeGreaterThan(0)
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

  it('retries on the next edit without consuming the throttle window when save fails', async () => {
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
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
      },
      30_000,
    )

    await expect(trigger('session1', 'canvas-a', doc)).resolves.toBeNull()
    await expect(trigger('session1', 'canvas-a', doc)).resolves.toEqual(entry)
    expect(save).toHaveBeenCalledTimes(2)
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
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      30_000,
      getHeadBranch,
    )
    await trigger('session1', 'canvas-a', doc)
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
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      30_000,
      getHeadBranch,
    )
    await trigger('session1', 'canvas-a', doc)
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
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      30_000,
      getHeadBranch,
    )

    await expect(trigger('session1', 'canvas-a', doc)).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('broken branch state'),
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('returns null without consuming the throttle window when versionStore.save throws corruption', async () => {
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
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      30_000,
    )

    await expect(trigger('session1', 'canvas-a', doc)).resolves.toBeNull()
    await expect(trigger('session1', 'canvas-a', doc)).resolves.toEqual(entry)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('throttles repeated calls within the interval window by tracking last-save time per canvas key', async () => {
    // The trigger holds an ephemeral per-canvas timestamp registry (Map<key, number>).
    // This test confirms the registry persists its state across calls within the same
    // trigger instance so that the throttle window is correctly enforced.
    //
    // Pin the clock so both the "first call always fires" invariant and the
    // "second call is throttled" assertion are grounded in an explicit time,
    // not a wall-clock assumption.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    const doc = new LoroDoc()
    const entry = {
      id: 'v1',
      path: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
      hasThumbnail: false,
    }
    const save = vi.fn().mockResolvedValue(entry)
    // Use a large interval so the second call (at the same pinned instant) always falls within the window.
    const trigger = createAutoVersionTrigger(
      {
        save,
        load: vi.fn(),
        list: vi.fn(),
        saveThumbnail: vi.fn(),
        loadThumbnail: vi.fn(),
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
      },
      60_000,
    )

    // First call: no prior save recorded → now - 0 >= intervalMs is true → should save.
    const first = await trigger('session1', 'canvas-a', doc)
    expect(first).toEqual(entry)
    expect(save).toHaveBeenCalledTimes(1)

    // Second call at the same pinned instant: within the 60s window → must return null.
    const second = await trigger('session1', 'canvas-a', doc)
    expect(second).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
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
      earliestFrontiers: vi.fn(),
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

    const app = createCanvasRouter({
      autoVersionIntervalMs: 0,
      versionStore,
    })
    const res = await app.request('/api/w/session1/canvas/canvas-a/update', {
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
