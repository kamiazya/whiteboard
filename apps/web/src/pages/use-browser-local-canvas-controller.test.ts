import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import {
  type LoroStoreLike,
  useBrowserLocalCanvasController,
} from './use-browser-local-canvas-controller.js'

class FakeLoroStore implements LoroStoreLike {
  saved: Array<{ id: string; bytes: Uint8Array }> = []
  shouldThrow = false

  async save(id: string, bytes: Uint8Array): Promise<void> {
    if (this.shouldThrow) throw new Error('loro save failed')
    this.saved.push({ id, bytes })
  }
}

const snap: CanvasSnapshot = {
  id: 'c1',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
}

describe('useBrowserLocalCanvasController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('snapshot starts as null before load completes', () => {
    const store = new MemoryStore()
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    expect(result.current.snapshot).toBeNull()
  })

  it('persistence starts as saved', () => {
    const store = new MemoryStore()
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    expect(result.current.persistence.kind).toBe('saved')
  })

  it('cleanupCompleted starts as false', () => {
    const store = new MemoryStore()
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    expect(result.current.cleanupCompleted).toBe(false)
  })

  it('creates and loads a new canvas when store is empty', async () => {
    const store = new MemoryStore()
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    expect(result.current.snapshot).not.toBeNull()
    expect(result.current.snapshot?.name).toBe('untitled')
  })

  it('loads existing canvas from store on mount', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    expect(result.current.snapshot).toEqual(snap)
  })

  it('renameCanvas transitions persistence pending -> saved via an immediate flush (no debounce)', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.renameCanvas('Renamed')
    })
    // renameCanvas flushes immediately (no setTimeout), so a microtask flush
    // settles it back to 'saved' without advancing any timers.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.persistence.kind).toBe('saved')
  })

  it('degraded message is generic safe copy — raw error not exposed', async () => {
    // Explicitly bind all methods; class-instance spread copies data fields but not prototype methods.
    const base = new MemoryStore()
    await base.setDefaultCanvasId('c1')
    await base.save(snap)
    const failingStore: BrowserLocalStore = {
      getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: base.load.bind(base),
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
      listCanvases: base.listCanvases.bind(base),
      save: async () => {
        throw new Error('IndexedDB: secret-key=abc123 transaction aborted')
      },
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(failingStore))
    await act(async () => {})
    await act(async () => {
      result.current.renameCanvas('Renamed')
    })
    expect(result.current.persistence.kind).toBe('degraded')
    if (result.current.persistence.kind === 'degraded') {
      expect(result.current.persistence.message).not.toMatch(/secret-key|abc123/i)
      expect(result.current.persistence.message).not.toMatch(
        /\btoken\b|\bAuthorization\b|\bBearer\b/i,
      )
    }
  })

  it('triggerCleanup flushes pending save then deletes canvas', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.renameCanvas('Renamed before cleanup')
    })
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupCompleted).toBe(true)
    expect(result.current.snapshot).toBeNull()
    // Canvas removed from store
    expect(await store.getDefaultCanvasId()).toBeNull()
  })

  it('cleanupError is a generic safe copy when flush fails — raw error not exposed', async () => {
    const base = new MemoryStore()
    await base.setDefaultCanvasId('c1')
    await base.save(snap)
    let shouldFailSave = false
    const store: BrowserLocalStore = {
      getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: base.load.bind(base),
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
      listCanvases: base.listCanvases.bind(base),
      save: async (s) => {
        if (shouldFailSave) throw new Error('secret-credential-xyz leaked error')
        return base.save(s)
      },
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    shouldFailSave = true
    // renameCanvas flushes immediately; let that failing save settle to 'degraded'
    // before triggerCleanup runs, matching how a real prior save failure lingers.
    await act(async () => {
      result.current.renameCanvas('Renamed')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.persistence.kind).toBe('degraded')
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupError).not.toBeNull()
    expect(result.current.cleanupError).not.toMatch(/secret-credential-xyz/i)
    expect(result.current.cleanupError).not.toMatch(/\btoken\b|\bAuthorization\b|\bBearer\b/i)
  })

  it('cleanupError is null on successful cleanup', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupError).toBeNull()
    expect(result.current.cleanupCompleted).toBe(true)
  })

  it('triggerCleanup aborts when flush fails — preserves data copy', async () => {
    const base = new MemoryStore()
    await base.setDefaultCanvasId('c1')
    await base.save(snap)
    let shouldFailSave = false
    const store: BrowserLocalStore = {
      getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: base.load.bind(base),
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
      listCanvases: base.listCanvases.bind(base),
      save: async (s) => {
        if (shouldFailSave) throw new Error('disk full')
        return base.save(s)
      },
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    shouldFailSave = true
    // renameCanvas flushes immediately and fails; let it settle to 'degraded'
    // before triggerCleanup runs, so triggerCleanup's own degraded-guard aborts.
    await act(async () => {
      result.current.renameCanvas('Renamed')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.persistence.kind).toBe('degraded')
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupCompleted).toBe(false)
    expect(result.current.snapshot).not.toBeNull()
    expect(await base.getDefaultCanvasId()).toBe('c1')
  })

  it('triggerCleanup is a no-op when del returns pointer-mismatch', async () => {
    const base = new MemoryStore()
    await base.setDefaultCanvasId('c1')
    await base.save(snap)
    const store: BrowserLocalStore = {
      getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: base.load.bind(base),
      generateId: base.generateId.bind(base),
      listCanvases: base.listCanvases.bind(base),
      save: base.save.bind(base),
      del: async () => ({ deleted: false, reason: 'pointer-mismatch' }),
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupCompleted).toBe(false)
    expect(result.current.snapshot).toEqual(snap)
  })

  it('no phantom save re-populates store after triggerCleanup', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.renameCanvas('Renamed')
    })
    await act(async () => {
      await result.current.triggerCleanup()
    })
    // Advance past any timer window — no un-flushed timer should save phantom data.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(await store.getDefaultCanvasId()).toBeNull()
    expect((await store.load('c1')).kind).toBe('not-found')
  })

  it('startFresh deletes the old canvas record before repointing the default', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    await act(async () => {
      await result.current.startFresh()
    })
    // The old canvas must not linger in the store: del() clears the default pointer,
    // so it has to run while 'c1' is still the default — i.e. before setDefaultCanvasId(new).
    expect((await store.load('c1')).kind).toBe('not-found')
    const newId = await store.getDefaultCanvasId()
    expect(newId).not.toBeNull()
    expect(newId).not.toBe('c1')
    expect((await store.load(newId as string)).kind).toBe('ok')
  })

  it('startFresh degrades and cleans up its orphan when repointing the default fails', async () => {
    const base = new MemoryStore()
    await base.setDefaultCanvasId('c1')
    await base.save(snap)
    const failingStore: BrowserLocalStore = {
      getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
      load: base.load.bind(base),
      save: base.save.bind(base),
      del: base.del.bind(base),
      removeCanvas: base.removeCanvas.bind(base),
      generateId: () => 'fresh-1',
      listCanvases: async () => [],
      setDefaultCanvasId: async () => {
        throw new Error('IndexedDB: meta write aborted')
      },
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(failingStore))
    await act(async () => {})
    await act(async () => {
      await result.current.startFresh()
    })
    expect(result.current.persistence.kind).toBe('degraded')
    if (result.current.persistence.kind === 'degraded') {
      expect(result.current.persistence.reason).toBe('recovery-failed')
    }
    // del() ran before the failed repoint, so the abandoned canvas is gone and the pointer is
    // null — a retry starts cleanly. The freshly-saved canvas is cleaned up via removeCanvas
    // so the failed recovery leaves no orphaned record behind.
    expect((await base.load('c1')).kind).toBe('not-found')
    expect((await base.load('fresh-1')).kind).toBe('not-found')
    expect(await base.getDefaultCanvasId()).toBeNull()
  })

  it('renameCanvas updates snapshot.name and persists it', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    await act(async () => {
      result.current.renameCanvas('New name')
    })
    expect(result.current.snapshot?.name).toBe('New name')
    const loadResult = await store.load('c1')
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('New name')
    }
  })

  it('renameCanvas racing with unmount does not warn or clobber a later mount', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.renameCanvas('Racing name')
    })
    unmount()
    // Let the in-flight save promise resolve after unmount.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('act(...)'))).toBe(false)
    warnSpy.mockRestore()

    // A subsequently-mounted controller must see the persisted rename, not a clobbered value.
    const { result: result2 } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    expect(result2.current.snapshot?.name).toBe('Racing name')
  })

  it('renameCanvas with whitespace-only input falls back to "untitled" and persists that, not empty', async () => {
    const named: CanvasSnapshot = { ...snap, name: 'My canvas' }
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(named)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    await act(async () => {
      result.current.renameCanvas('   ')
    })
    expect(result.current.snapshot?.name).toBe('untitled')
    const loadResult = await store.load('c1')
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('untitled')
      expect(loadResult.snapshot.name).not.toBe('')
    }
  })

  it('renameCanvas with empty string also falls back to "untitled"', async () => {
    const named: CanvasSnapshot = { ...snap, name: 'My canvas' }
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(named)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    await act(async () => {
      result.current.renameCanvas('')
    })
    expect(result.current.snapshot?.name).toBe('untitled')
  })

  it('renameCanvas before the initial load resolves is a safe no-op', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    // No awaited act() yet — the async load hasn't populated snapshotRef/pendingSnapshotRef.
    expect(result.current.snapshot).toBeNull()
    act(() => {
      result.current.renameCanvas('Too early')
    })
    expect(result.current.snapshot).toBeNull()
    expect(result.current.persistence.kind).toBe('saved')
    // Let the load finish and confirm the store was never touched by the no-op call.
    await act(async () => {})
    const loadResult = await store.load('c1')
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe(snap.name)
    }
  })

  it('renameCanvas after cleanup cleared the snapshot is a safe no-op', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.snapshot).toBeNull()
    act(() => {
      result.current.renameCanvas('After cleanup')
    })
    expect(result.current.snapshot).toBeNull()
    expect(await store.getDefaultCanvasId()).toBeNull()
  })

  it('renameCanvas refreshes updatedAt and transitions persistence to saved', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    await act(async () => {
      result.current.renameCanvas('New name')
    })
    expect(result.current.snapshot?.updatedAt).not.toBe(snap.updatedAt)
    expect(result.current.persistence.kind).toBe('saved')
  })

  describe('multi-canvas: listCanvases / createCanvas / switchCanvas', () => {
    it('listCanvases reflects the auto-created canvas on first mount', async () => {
      const store = new MemoryStore()
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
      await act(async () => {})
      const list = await result.current.listCanvases()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(result.current.snapshot?.id)
    })

    it('createCanvas returns a fresh snapshot, persists metadata, writes an empty Loro doc, and does not change current snapshot', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
      await act(async () => {})
      const currentBefore = result.current.snapshot

      let created: CanvasSnapshot | undefined
      await act(async () => {
        created = await result.current.createCanvas('Second canvas')
      })

      expect(created).toBeDefined()
      expect(created?.id).not.toBe('c1')
      expect(created?.name).toBe('Second canvas')
      expect(result.current.snapshot).toEqual(currentBefore)
      expect(await store.getDefaultCanvasId()).toBe('c1')

      const persisted = await store.load(created!.id)
      expect(persisted).toEqual({ kind: 'ok', snapshot: created })
      expect(loro.saved.some((s) => s.id === created!.id)).toBe(true)
    })

    it('createCanvas defaults the name to "untitled" when none is given', async () => {
      const store = new MemoryStore()
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
      await act(async () => {})
      let created: CanvasSnapshot | undefined
      await act(async () => {
        created = await result.current.createCanvas()
      })
      expect(created?.name).toBe('untitled')
    })

    it('createCanvas rolls back the metadata row when the Loro write fails', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      const loro = new FakeLoroStore()
      loro.shouldThrow = true
      const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
      await act(async () => {})

      let thrown: unknown
      await act(async () => {
        try {
          await result.current.createCanvas('Doomed')
        } catch (err) {
          thrown = err
        }
      })
      expect(thrown).toBeDefined()

      const list = await store.listCanvases()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe('c1')
    })

    it('listCanvases includes canvases created via createCanvas', async () => {
      const store = new MemoryStore()
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
      await act(async () => {})
      await act(async () => {
        await result.current.createCanvas('Second canvas')
      })
      const list = await result.current.listCanvases()
      expect(list).toHaveLength(2)
    })

    it('switchCanvas flushes a pending edit on the current canvas, then sets the target as current and updates the default pointer', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
      await act(async () => {})

      let created: CanvasSnapshot | undefined
      await act(async () => {
        created = await result.current.createCanvas('Second canvas')
      })

      act(() => {
        result.current.renameCanvas('Renamed before switch')
      })

      await act(async () => {
        await result.current.switchCanvas(created!.id)
      })

      expect(result.current.snapshot?.id).toBe(created!.id)
      expect(await store.getDefaultCanvasId()).toBe(created!.id)

      const flushed = await store.load('c1')
      expect(flushed).toEqual({
        kind: 'ok',
        snapshot: { ...snap, name: 'Renamed before switch', updatedAt: expect.any(String) },
      })
    })

    it('switchCanvas to an unknown id is a safe no-op', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
      await act(async () => {})
      const before = result.current.snapshot

      await act(async () => {
        await result.current.switchCanvas('does-not-exist')
      })

      expect(result.current.snapshot).toEqual(before)
      expect(await store.getDefaultCanvasId()).toBe('c1')
    })

    it('switchCanvas degrades persistence instead of rejecting when load() throws', async () => {
      const base = new MemoryStore()
      await base.setDefaultCanvasId('c1')
      await base.save(snap)
      const throwingStore: BrowserLocalStore = {
        getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
        setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
        save: base.save.bind(base),
        del: base.del.bind(base),
        generateId: base.generateId.bind(base),
        listCanvases: base.listCanvases.bind(base),
        load: async (id: string) => {
          if (id === 'boom') throw new Error('IndexedDB: read aborted')
          return base.load(id)
        },
      }
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(throwingStore, loro))
      await act(async () => {})

      await act(async () => {
        await result.current.switchCanvas('boom')
      })

      expect(result.current.persistence.kind).toBe('degraded')
      // Current snapshot and default pointer must stay untouched by the failed switch.
      expect(result.current.snapshot).toEqual(snap)
      expect(await throwingStore.getDefaultCanvasId()).toBe('c1')
    })

    it('switchCanvas degrades persistence instead of rejecting when setDefaultCanvasId() throws', async () => {
      const base = new MemoryStore()
      await base.setDefaultCanvasId('c1')
      await base.save(snap)
      const throwingStore: BrowserLocalStore = {
        getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
        setDefaultCanvasId: async () => {
          throw new Error('IndexedDB: meta write aborted')
        },
        save: base.save.bind(base),
        del: base.del.bind(base),
        generateId: base.generateId.bind(base),
        listCanvases: base.listCanvases.bind(base),
        load: base.load.bind(base),
      }
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(throwingStore, loro))
      await act(async () => {})

      let created: CanvasSnapshot | undefined
      await act(async () => {
        created = await result.current.createCanvas('Second canvas')
      })

      await act(async () => {
        await result.current.switchCanvas(created!.id)
      })

      expect(result.current.persistence.kind).toBe('degraded')
      expect(result.current.snapshot).toEqual(snap)
      expect(await base.getDefaultCanvasId()).toBe('c1')
    })

    it('switchCanvas waits for an in-flight fire-and-forget rename flush before switching, and aborts the switch if that flush fails', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
      await act(async () => {})

      let created: CanvasSnapshot | undefined
      await act(async () => {
        created = await result.current.createCanvas('Second canvas')
      })

      // Intercept the next save() (the one renameCanvas's fire-and-forget
      // flushSave triggers) so the test controls exactly when it settles.
      let rejectFirstSave!: (err: unknown) => void
      let firstSaveStarted = false
      const originalSave = store.save.bind(store)
      let interceptNext = true
      store.save = (s: CanvasSnapshot) => {
        if (interceptNext) {
          interceptNext = false
          firstSaveStarted = true
          return new Promise<void>((_resolve, reject) => {
            rejectFirstSave = reject
          })
        }
        return originalSave(s)
      }

      // Fire-and-forget flush, exactly like renameCanvas triggers internally.
      act(() => {
        result.current.renameCanvas('Renamed before switch')
      })
      expect(firstSaveStarted).toBe(true)

      let switchSettled = false
      const switchPromise = result.current.switchCanvas(created!.id).then(() => {
        switchSettled = true
      })

      // Let pending microtasks run without resolving the intercepted save —
      // switchCanvas must still be waiting on it, not racing past it.
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(switchSettled).toBe(false)
      expect(await store.getDefaultCanvasId()).toBe('c1')

      await act(async () => {
        rejectFirstSave(new Error('save failed'))
        await switchPromise
      })

      expect(switchSettled).toBe(true)
      expect(result.current.persistence.kind).toBe('degraded')
      // The failed flush must abort the switch: default pointer stays on the
      // original canvas instead of silently losing the rename.
      expect(await store.getDefaultCanvasId()).toBe('c1')
      expect(result.current.snapshot?.id).toBe('c1')
    })
  })
})
