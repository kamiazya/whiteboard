import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { useBrowserLocalCanvasController } from './use-browser-local-canvas-controller.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'

const snap: CanvasSnapshot = {
  id: 'c1',
  name: 'untitled',
  scene: { elements: [] },
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
    expect(result.current.snapshot?.scene.elements).toEqual([])
  })

  it('loads existing canvas from store on mount', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    expect(result.current.snapshot).toEqual(snap)
  })

  it('updateScene sets persistence to pending', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.updateScene([{ type: 'rectangle' }])
    })
    expect(result.current.persistence.kind).toBe('pending')
  })

  it('persistence becomes saved after debounce timer fires', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.updateScene([{ type: 'rectangle' }])
    })
    expect(result.current.persistence.kind).toBe('pending')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
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
      save: async () => {
        throw new Error('IndexedDB: secret-key=abc123 transaction aborted')
      },
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(failingStore))
    await act(async () => {})
    act(() => {
      result.current.updateScene([{ type: 'rectangle' }])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
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
      result.current.updateScene([{ type: 'line' }])
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
      save: async (s) => {
        if (shouldFailSave) throw new Error('secret-credential-xyz leaked error')
        return base.save(s)
      },
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    shouldFailSave = true
    act(() => {
      result.current.updateScene([{ type: 'circle' }])
    })
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
      save: async (s) => {
        if (shouldFailSave) throw new Error('disk full')
        return base.save(s)
      },
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    shouldFailSave = true
    act(() => {
      result.current.updateScene([{ type: 'circle' }]) // sets pendingSnapshotRef
    })
    // triggerCleanup triggers flushSave with pending data; save fails → abort
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

  it('rapid updateScene calls within debounce window coalesce into a single save', async () => {
    const base = new MemoryStore()
    await base.setDefaultCanvasId('c1')
    await base.save(snap)
    let saveCount = 0
    const trackingStore: BrowserLocalStore = {
      getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: base.load.bind(base),
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
      save: async (s) => {
        saveCount++
        return base.save(s)
      },
    }
    const { result } = renderHook(() => useBrowserLocalCanvasController(trackingStore))
    await act(async () => {})
    saveCount = 0 // ignore initial load (no save triggered on load)
    act(() => {
      result.current.updateScene([{ type: 'a' }])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    }) // halfway
    act(() => {
      result.current.updateScene([{ type: 'b' }])
    }) // resets debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    }) // past second debounce
    expect(saveCount).toBe(1)
  })

  it('no phantom save re-populates store after triggerCleanup', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.updateScene([{ type: 'line' }])
    })
    await act(async () => {
      await result.current.triggerCleanup()
    })
    // Advance past the debounce window — any un-flushed timer would save phantom data
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

  it('renameCanvas merges with a concurrently-pending scene edit (updateScene then renameCanvas)', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.updateScene([{ type: 'rectangle' }])
    })
    await act(async () => {
      result.current.renameCanvas('Renamed')
    })
    const loadResult = await store.load('c1')
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('Renamed')
      expect(loadResult.snapshot.scene.elements).toEqual([{ type: 'rectangle' }])
    }
  })

  it('renameCanvas merges with a concurrently-pending scene edit (renameCanvas then updateScene)', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.renameCanvas('Renamed')
    })
    act(() => {
      result.current.updateScene([{ type: 'rectangle' }])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const loadResult = await store.load('c1')
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('Renamed')
      expect(loadResult.snapshot.scene.elements).toEqual([{ type: 'rectangle' }])
    }
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

  it('save/reload roundtrip: saved elements persist in store', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    const { result } = renderHook(() => useBrowserLocalCanvasController(store))
    await act(async () => {})
    act(() => {
      result.current.updateScene([{ type: 'ellipse' }])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const loadResult = await store.load('c1')
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.scene.elements).toEqual([{ type: 'ellipse' }])
    }
  })
})
