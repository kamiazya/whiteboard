import { act, renderHook } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import {
  type LoroStoreLike,
  useBrowserDocumentController,
} from './use-browser-document-controller.js'

class FakeLoroStore implements LoroStoreLike {
  saved: Array<{ id: string; bytes: Uint8Array }> = []
  shouldThrow = false
  private byId = new Map<string, Uint8Array>()

  async save(id: string, bytes: Uint8Array): Promise<void> {
    if (this.shouldThrow) throw new Error('loro save failed')
    this.saved.push({ id, bytes })
    this.byId.set(id, bytes)
  }

  createEmptySnapshot(): Uint8Array {
    // Fake in-memory bytes — the fake never touches real loro-crdt, matching
    // the isolation LoroStoreLike is meant to provide to this test file.
    return new Uint8Array([1, 2, 3])
  }

  async load(id: string): Promise<LoroLoadResult> {
    const bytes = this.byId.get(id)
    if (bytes === undefined) return { kind: 'not-found' }
    return { kind: 'ok', snapshot: bytes }
  }
}

// duplicateDocument runs the real loro-crdt merge/export (mergeToSnapshot),
// so its tests need real Loro bytes rather than the fake's placeholder
// `[1, 2, 3]` — that would throw when mergeToSnapshot tries to import it.
function realSnapshotWithElements(elements: unknown[]): Uint8Array {
  const doc = new Loro()
  const list = doc.getList('elements')
  for (const el of elements) list.push(el)
  return doc.export({ mode: 'snapshot' })
}

// ULIDs, because the stored schema validates them now. Named constants
// rather than inline literals: a 26-character id read six times in one
// assertion is unreadable, and the tests are about which document, not which
// characters.
const C1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const C2 = '01ARZ3NDEKTSV4RRFFQ69G5FB0'

const snap: DocumentSnapshot = {
  documentId: C1,
  workspaceId: getBrowserWorkspaceId(),
  path: 'untitled',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
  kind: 'spatial' as const,
}

describe('useBrowserDocumentController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('snapshot starts as null before load completes', () => {
    const store = new LocalStoreDouble()
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    expect(result.current.snapshot).toBeNull()
  })

  it('persistence starts as saved', () => {
    const store = new LocalStoreDouble()
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    expect(result.current.persistence.kind).toBe('saved')
  })

  it('cleanupCompleted starts as false', () => {
    const store = new LocalStoreDouble()
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    expect(result.current.cleanupCompleted).toBe(false)
  })

  it('creates and loads a new canvas when store is empty', async () => {
    const store = new LocalStoreDouble()
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    expect(result.current.snapshot).not.toBeNull()
    expect(result.current.snapshot?.name).toBe('untitled')
  })

  it('loads existing canvas from store on mount', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    expect(result.current.snapshot).toEqual(snap)
  })

  it('renameDocument transitions persistence pending -> saved via an immediate flush (no debounce)', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    act(() => {
      result.current.renameDocument('Renamed')
    })
    // renameDocument flushes immediately (no setTimeout), so a microtask flush
    // settles it back to 'saved' without advancing any timers.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.persistence.kind).toBe('saved')
  })

  it('degraded message is generic safe copy — raw error not exposed', async () => {
    // Explicitly bind all methods; class-instance spread copies data fields but not prototype methods.
    const base = new LocalStoreDouble()
    await base.setDefaultDocumentId(C1)
    await base.save(snap)
    const failingStore = base
    // The rename path: `save` carried it before, and the index keys
    // it by id so a rename cannot move the document.
    base.index.setDocumentName = async () => {
      throw new Error('IndexedDB: secret-key=abc123 transaction aborted')
    }
    const { result } = renderHook(() =>
      useBrowserDocumentController(failingStore.index, {
        loro: failingStore.loro,
        pointer: failingStore.pointer,
        clock: failingStore.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      result.current.renameDocument('Renamed').catch(() => {})
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
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    act(() => {
      result.current.renameDocument('Renamed before cleanup')
    })
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupCompleted).toBe(true)
    expect(result.current.snapshot).toBeNull()
    // Canvas removed from store
    expect(await store.getDefaultDocumentId()).toBeNull()
  })

  it('cleanupError is a generic safe copy when flush fails — raw error not exposed', async () => {
    const base = new LocalStoreDouble()
    await base.setDefaultDocumentId(C1)
    await base.save(snap)
    let shouldFailSave = false
    const store = base
    // The rename path: `save` carried it before, and the index keys
    // it by id so a rename cannot move the document.
    const setName = base.index.setDocumentName.bind(base.index)
    base.index.setDocumentName = async (input) => {
      if (shouldFailSave) throw new Error('secret-credential-xyz leaked error')
      return setName(input)
    }
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    shouldFailSave = true
    // renameDocument flushes immediately; let that failing save settle to 'degraded'
    // before triggerCleanup runs, matching how a real prior save failure lingers.
    // Its returned promise rejects on this failed save (see the dedicated
    // rejection test below) — catch it here since this test only cares about
    // the resulting persistence/cleanup state, not the rejection itself.
    await act(async () => {
      result.current.renameDocument('Renamed').catch(() => {})
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

  it('renameDocument returns a promise that rejects when the underlying save fails', async () => {
    // Root cause: callers such as WorkspaceTopBar await onRenameDocument and
    // treat a rejection as "keep the rename input open for retry". Before this
    // fix renameDocument's return type was `void`, so a real save failure could
    // never surface as a rejection — the caller always saw success.
    const base = new LocalStoreDouble()
    await base.setDefaultDocumentId(C1)
    await base.save(snap)
    let shouldFailSave = false
    const store = base
    // The rename path: `save` carried it before, and the index keys
    // it by id so a rename cannot move the document.
    const setName = base.index.setDocumentName.bind(base.index)
    base.index.setDocumentName = async (input) => {
      if (shouldFailSave) throw new Error('disk full')
      return setName(input)
    }
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    shouldFailSave = true
    let caught: unknown
    await act(async () => {
      try {
        await result.current.renameDocument('Renamed')
      } catch (err) {
        caught = err
      }
    })
    expect(caught).toBeInstanceOf(Error)
    expect(result.current.persistence.kind).toBe('degraded')
  })

  it('cleanupError is null on successful cleanup', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupError).toBeNull()
    expect(result.current.cleanupCompleted).toBe(true)
  })

  it('triggerCleanup aborts when flush fails — preserves data copy', async () => {
    const base = new LocalStoreDouble()
    await base.setDefaultDocumentId(C1)
    await base.save(snap)
    let shouldFailSave = false
    const store = base
    // The rename path: `save` carried it before, and the index keys
    // it by id so a rename cannot move the document.
    const setName = base.index.setDocumentName.bind(base.index)
    base.index.setDocumentName = async (input) => {
      if (shouldFailSave) throw new Error('disk full')
      return setName(input)
    }
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    shouldFailSave = true
    // renameDocument flushes immediately and fails; let it settle to 'degraded'
    // before triggerCleanup runs, so triggerCleanup's own degraded-guard aborts.
    // The returned promise rejects on this failed save — caught here since
    // this test only cares about the resulting cleanup-abort state.
    await act(async () => {
      result.current.renameDocument('Renamed').catch(() => {})
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.persistence.kind).toBe('degraded')
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupCompleted).toBe(false)
    expect(result.current.snapshot).not.toBeNull()
    expect(await base.getDefaultDocumentId()).toBe(C1)
  })

  it('triggerCleanup is a no-op when the pointer no longer names a document the index holds', async () => {
    // The bespoke store's `del` compared against the default pointer itself
    // and answered 'pointer-mismatch'; the port has no such coupling, so the
    // check moved into the controller and reads as a resolve that finds
    // nothing. Same guarantee: cleanup that cannot identify its target
    // removes nothing rather than removing the wrong thing.
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.cleanupCompleted).toBe(false)
    expect(result.current.snapshot).toEqual(snap)
  })

  it('no phantom save re-populates store after triggerCleanup', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    act(() => {
      result.current.renameDocument('Renamed')
    })
    await act(async () => {
      await result.current.triggerCleanup()
    })
    // Advance past any timer window — no un-flushed timer should save phantom data.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(await store.getDefaultDocumentId()).toBeNull()
    expect(await store.load(C1)).toBeNull()
  })

  it('startFresh deletes the old canvas record before repointing the default', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      await result.current.startFresh()
    })
    // The old canvas must not linger in the store: del() clears the default pointer,
    // so it has to run while C1 is still the default — i.e. before setDefaultDocumentId(new).
    expect(await store.load(C1)).toBeNull()
    const newId = await store.getDefaultDocumentId()
    expect(newId).not.toBeNull()
    expect(newId).not.toBe(C1)
    expect(await store.load(newId as string)).not.toBeNull()
  })

  it('startFresh degrades and cleans up its orphan when repointing the default fails', async () => {
    const base = new LocalStoreDouble()
    await base.setDefaultDocumentId(C1)
    await base.save(snap)
    base.pointer.set = async () => {
      throw new Error('IndexedDB: meta write aborted')
    }
    const { result } = renderHook(() =>
      useBrowserDocumentController(base.index, {
        loro: base.loro,
        pointer: base.pointer,
        clock: base.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      await result.current.startFresh()
    })
    expect(result.current.persistence.kind).toBe('degraded')
    if (result.current.persistence.kind === 'degraded') {
      expect(result.current.persistence.reason).toBe('recovery-failed')
    }
    // The old canvas was dropped and the pointer cleared before the failed
    // repoint — a retry starts cleanly rather than resuming into a document
    // that is no longer there.
    expect(await base.load(C1)).toBeNull()
    expect(await base.getDefaultDocumentId()).toBeNull()
    // The fresh document SURVIVES, unpointed. That is a change: the bespoke
    // store's recovery deleted it, because a record its `del` could not reach
    // was an orphan. Created through the index it is an ordinary document at
    // an ordinary path, which the next create numbers around, and deleting a
    // complete document the user may have already drawn in would lose more
    // than it tidies.
    expect(await base.listDocuments()).toHaveLength(1)
  })

  it('renameDocument updates snapshot.name and persists it', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      result.current.renameDocument('New name')
    })
    expect(result.current.snapshot?.name).toBe('New name')
    const loaded = await store.load(C1)
    expect(loaded?.name).toBe('New name')
  })

  it('renameDocument racing with unmount does not warn or clobber a later mount', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    act(() => {
      result.current.renameDocument('Racing name')
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
    const { result: result2 } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    expect(result2.current.snapshot?.name).toBe('Racing name')
  })

  it('renameDocument with whitespace-only input falls back to "untitled" and persists that, not empty', async () => {
    const named: DocumentSnapshot = { ...snap, name: 'My canvas' }
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(named)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      result.current.renameDocument('   ')
    })
    expect(result.current.snapshot?.name).toBe('untitled')
    const loaded = await store.load(C1)
    expect(loaded?.name).toBe('untitled')
    expect(loaded?.name).not.toBe('')
  })

  it('renameDocument with empty string also falls back to "untitled"', async () => {
    const named: DocumentSnapshot = { ...snap, name: 'My canvas' }
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(named)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      result.current.renameDocument('')
    })
    expect(result.current.snapshot?.name).toBe('untitled')
  })

  it('renameDocument before the initial load resolves is a safe no-op', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    // No awaited act() yet — the async load hasn't populated snapshotRef/pendingSnapshotRef.
    expect(result.current.snapshot).toBeNull()
    act(() => {
      result.current.renameDocument('Too early')
    })
    expect(result.current.snapshot).toBeNull()
    expect(result.current.persistence.kind).toBe('saved')
    // Let the load finish and confirm the store was never touched by the no-op call.
    await act(async () => {})
    const loaded = await store.load(C1)
    expect(loaded?.name).toBe(snap.name)
  })

  it('renameDocument after cleanup cleared the snapshot is a safe no-op', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      await result.current.triggerCleanup()
    })
    expect(result.current.snapshot).toBeNull()
    act(() => {
      result.current.renameDocument('After cleanup')
    })
    expect(result.current.snapshot).toBeNull()
    expect(await store.getDefaultDocumentId()).toBeNull()
  })

  it('renameDocument refreshes updatedAt and transitions persistence to saved', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      result.current.renameDocument('New name')
    })
    expect(result.current.snapshot?.updatedAt).not.toBe(snap.updatedAt)
    expect(result.current.persistence.kind).toBe('saved')
  })

  // Typing commits per keystroke, so "type, change your mind, put the old
  // name back" is two renames in quick succession with the first one's write
  // possibly still in flight. Whichever was asked for LAST has to be the one
  // that survives, in the snapshot the header reads and in the store.
  it('the later of two overlapping renames wins, in state and in the store', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)

    // Hold the first write open so the second rename is issued while it is
    // still in flight — the ordering this guards only exists then.
    const realSet = store.index.setDocumentName.bind(store.index)
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    store.index.setDocumentName = async (args) => {
      calls += 1
      if (calls === 1) await firstHeld
      return realSet(args)
    }

    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})

    await act(async () => {
      void result.current.renameDocument('Half-typed name')
      void result.current.renameDocument('Restored name')
      releaseFirst()
    })

    expect(result.current.snapshot?.name).toBe('Restored name')
    const stored = await store.index.resolveDocumentById({
      workspaceId: getBrowserWorkspaceId(),
      documentId: C1,
    })
    expect(stored?.name).toBe('Restored name')
  })

  // The shape change is only real if the controller MINTS the new fields.
  // Converting the fixtures made 44 tests compile again while asserting
  // nothing about workspace or path — both mutations below stayed green
  // until these were written.
  describe('the address a new document is given', () => {
    it('stamps the local workspace on what it creates', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: new FakeLoroStore(),
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let created: DocumentSnapshot | undefined
      await act(async () => {
        created = await result.current.createDocument('Second')
      })
      expect(created?.workspaceId).toBe(getBrowserWorkspaceId())
    })

    // Two documents at one address is the failure the path exists to
    // prevent, and a duplicate is the operation most likely to produce it.
    it('gives a duplicate its own path, not the source’s', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      await loro.save(C1, realSnapshotWithElements([{ id: 'rect-1' }]))
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let duplicated: DocumentSnapshot | undefined
      await act(async () => {
        duplicated = await result.current.duplicateDocument()
      })

      expect(duplicated?.path).not.toBe(snap.path)
      const list = await store.listDocuments()
      expect(new Set(list.map((row) => row.path)).size).toBe(list.length)
    })
  })

  describe('initialPath (deep-linked document)', () => {
    const other: DocumentSnapshot = {
      documentId: C2,
      workspaceId: getBrowserWorkspaceId(),
      path: 'other-canvas',
      name: 'other canvas',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    }

    it('loads the requested canvas instead of the store default when given', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      await store.save(other)
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: store.loro,
          initialPath: other.path,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      expect(result.current.snapshot).toEqual(other)
    })

    it('resolves by path only — the document id is not an address here', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      await store.save(other)
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: store.loro,
          initialPath: other.documentId,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      expect(result.current.snapshot).toEqual(snap)
    })

    it('repoints the store default to the requested canvas so a later plain load resumes there', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      await store.save(other)
      renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: store.loro,
          initialPath: other.path,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      expect(await store.getDefaultDocumentId()).toBe(C2)
    })

    it('falls back to the normal default-canvas flow when the requested path is not found (stale/bookmarked link)', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: store.loro,
          initialPath: 'does-not-exist',
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      // No error wall — silently lands on whatever the store's own default
      // resolves to, exactly like a plain (no initialPath) mount would.
      expect(result.current.snapshot).toEqual(snap)
      expect(result.current.persistence.kind).toBe('saved')
    })

    it('falls back to the default document when the path read itself fails', async () => {
      // The deep link is resolved by listing, so a store that cannot list is
      // indistinguishable from a path that is not there — and the fallback is
      // the same. This is the reachable version of the create path's own
      // tolerance: App only mounts this page WITH a path, so a throw here
      // would dead-end every deep link on a degraded store, even though the
      // default pointer below could still answer.
      const base = new LocalStoreDouble()
      await base.setDefaultDocumentId(C1)
      await base.save(snap)
      base.index.resolveDocument = () => Promise.reject(new Error('idb blocked'))
      const { result } = renderHook(() =>
        useBrowserDocumentController(base.index, {
          loro: base.loro,
          initialPath: 'other-canvas',
          pointer: base.pointer,
          clock: base.clock,
        }),
      )
      await act(async () => {})
      expect(result.current.snapshot).toEqual(snap)
      expect(result.current.persistence.kind).toBe('saved')
    })

    it('behaves exactly like today when initialPath is omitted', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: store.loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      expect(result.current.snapshot).toEqual(snap)
    })
  })

  describe('multi-canvas: listDocuments / createDocument / switchDocument', () => {
    it('listDocuments reflects the auto-created canvas on first mount', async () => {
      const store = new LocalStoreDouble()
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      const list = await result.current.listDocuments()
      expect(list).toHaveLength(1)
      expect(list[0].documentId).toBe(result.current.snapshot?.documentId)
    })

    it('createDocument returns a fresh snapshot, persists metadata, writes an empty Loro doc, and does not change current snapshot', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      const currentBefore = result.current.snapshot

      let created: DocumentSnapshot | undefined
      await act(async () => {
        created = await result.current.createDocument('Second canvas')
      })

      expect(created).toBeDefined()
      expect(created?.documentId).not.toBe(C1)
      expect(created?.name).toBe('Second canvas')
      expect(result.current.snapshot).toEqual(currentBefore)
      expect(await store.getDefaultDocumentId()).toBe(C1)

      expect(await store.load(created!.documentId)).toEqual(created)
      expect(loro.saved.some((s) => s.id === created!.documentId)).toBe(true)
    })

    it('createDocument defaults the name to "untitled" when none is given', async () => {
      // Seeded, so the mount does not take 'untitled' for itself first: an
      // unnamed document reads as its path, and the index refuses to hand out
      // the same path twice.
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save({ ...snap, path: 'existing', name: 'Existing' })
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      let created: DocumentSnapshot | undefined
      await act(async () => {
        created = await result.current.createDocument()
      })
      expect(created?.name).toBe('untitled')
    })

    it('createDocument rolls back the metadata row when the Loro write fails', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      loro.shouldThrow = true
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let thrown: unknown
      await act(async () => {
        try {
          await result.current.createDocument('Doomed')
        } catch (err) {
          thrown = err
        }
      })
      expect(thrown).toBeDefined()

      const list = await store.listDocuments()
      expect(list).toHaveLength(1)
      expect(list[0].documentId).toBe(C1)
    })

    it('listDocuments includes documents created via createDocument', async () => {
      const store = new LocalStoreDouble()
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      await act(async () => {
        await result.current.createDocument('Second canvas')
      })
      const list = await result.current.listDocuments()
      expect(list).toHaveLength(2)
    })

    it('switchDocument flushes a pending edit on the current canvas, then sets the target as current and updates the default pointer', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let created: DocumentSnapshot | undefined
      await act(async () => {
        created = await result.current.createDocument('Second canvas')
      })

      act(() => {
        result.current.renameDocument('Renamed before switch')
      })

      await act(async () => {
        await result.current.switchDocument(created!.documentId)
      })

      expect(result.current.snapshot?.documentId).toBe(created!.documentId)
      expect(await store.getDefaultDocumentId()).toBe(created!.documentId)

      const flushed = await store.load(C1)
      expect(flushed).toEqual({
        ...snap,
        name: 'Renamed before switch',
        updatedAt: expect.any(String),
      })
    })

    it('switchDocument to an unknown id resolves false and leaves the current canvas untouched (recoverable miss)', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})
      const before = result.current.snapshot

      let switched: boolean | undefined
      await act(async () => {
        switched = await result.current.switchDocument('does-not-exist')
      })

      // A missing target is exactly what a stale /local/:id bookmark
      // produces — the caller (the page) repairs the URL, so the controller
      // must NOT park the whole page on a degraded screen.
      expect(switched).toBe(false)
      expect(result.current.persistence.kind).toBe('saved')
      expect(result.current.snapshot).toEqual(before)
      expect(await store.getDefaultDocumentId()).toBe(C1)
    })

    it('switchDocument clears a stale degraded banner from the previous canvas on a successful switch', async () => {
      const base = new LocalStoreDouble()
      await base.setDefaultDocumentId(C1)
      await base.save(snap)
      // 'corrupt-1' reads as an unreadable record: not-found is a
      // recoverable miss and no longer degrades, so a corrupt read is the
      // way a failed switch leaves a degraded banner behind.
      const resolve = base.index.resolveDocumentById.bind(base.index)
      base.index.resolveDocumentById = async (input) => {
        if (input.documentId === 'corrupt-1') throw new Error('IndexedDB: record unreadable')
        return resolve(input)
      }
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(base.index, {
          loro: loro,
          pointer: base.pointer,
          clock: base.clock,
        }),
      )
      await act(async () => {})

      let created: DocumentSnapshot | undefined
      await act(async () => {
        created = await result.current.createDocument('Second canvas')
      })

      // Leave a stale degraded banner behind, as a prior corrupt-record
      // switch would.
      await act(async () => {
        await result.current.switchDocument('corrupt-1')
      })
      expect(result.current.persistence.kind).toBe('degraded')

      await act(async () => {
        await result.current.switchDocument(created!.documentId)
      })

      expect(result.current.persistence.kind).toBe('saved')
      expect(result.current.snapshot?.documentId).toBe(created!.documentId)
    })

    it('switchDocument degrades persistence instead of rejecting when load() throws', async () => {
      const base = new LocalStoreDouble()
      await base.setDefaultDocumentId(C1)
      await base.save(snap)
      const resolve = base.index.resolveDocumentById.bind(base.index)
      base.index.resolveDocumentById = async (input) => {
        if (input.documentId === 'boom') throw new Error('IndexedDB: read aborted')
        return resolve(input)
      }
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(base.index, {
          loro: loro,
          pointer: base.pointer,
          clock: base.clock,
        }),
      )
      await act(async () => {})

      await act(async () => {
        await result.current.switchDocument('boom')
      })

      expect(result.current.persistence.kind).toBe('degraded')
      // Current snapshot and default pointer must stay untouched by the failed switch.
      expect(result.current.snapshot).toEqual(snap)
      expect(await base.getDefaultDocumentId()).toBe(C1)
    })

    it('switchDocument degrades persistence instead of rejecting when setDefaultDocumentId() throws', async () => {
      const base = new LocalStoreDouble()
      await base.setDefaultDocumentId(C1)
      await base.save(snap)
      base.pointer.set = async () => {
        throw new Error('IndexedDB: meta write aborted')
      }
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(base.index, {
          loro: loro,
          pointer: base.pointer,
          clock: base.clock,
        }),
      )
      await act(async () => {})

      let created: DocumentSnapshot | undefined
      await act(async () => {
        created = await result.current.createDocument('Second canvas')
      })

      await act(async () => {
        await result.current.switchDocument(created!.documentId)
      })

      expect(result.current.persistence.kind).toBe('degraded')
      expect(result.current.snapshot).toEqual(snap)
      expect(await base.getDefaultDocumentId()).toBe(C1)
    })

    it('switchDocument waits for an in-flight fire-and-forget rename flush before switching, and aborts the switch if that flush fails', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let created: DocumentSnapshot | undefined
      await act(async () => {
        created = await result.current.createDocument('Second canvas')
      })

      // Intercept the next save() (the one renameDocument's fire-and-forget
      // flushSave triggers) so the test controls exactly when it settles.
      let rejectFirstSave!: (err: unknown) => void
      let firstSaveStarted = false
      const originalSave = store.index.setDocumentName.bind(store.index)
      let interceptNext = true
      store.index.setDocumentName = (input) => {
        if (interceptNext) {
          interceptNext = false
          firstSaveStarted = true
          return new Promise<void>((_resolve, reject) => {
            rejectFirstSave = reject
          })
        }
        return originalSave(input)
      }

      // Fire-and-forget flush, exactly like renameDocument triggers internally.
      // The intercepted save rejects below, so catch here — this test only
      // cares about switchDocument's abort behavior, not this rejection.
      act(() => {
        result.current.renameDocument('Renamed before switch').catch(() => {})
      })
      expect(firstSaveStarted).toBe(true)

      let switchSettled = false
      const switchPromise = result.current.switchDocument(created!.documentId).then(() => {
        switchSettled = true
      })

      // Let pending microtasks run without resolving the intercepted save —
      // switchDocument must still be waiting on it, not racing past it.
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(switchSettled).toBe(false)
      expect(await store.getDefaultDocumentId()).toBe(C1)

      await act(async () => {
        rejectFirstSave(new Error('save failed'))
        await switchPromise
      })

      expect(switchSettled).toBe(true)
      expect(result.current.persistence.kind).toBe('degraded')
      // The failed flush must abort the switch: default pointer stays on the
      // original canvas instead of silently losing the rename.
      expect(await store.getDefaultDocumentId()).toBe(C1)
      expect(result.current.snapshot?.documentId).toBe(C1)
    })

    it('two concurrent flush waiters both observe the second save that starts once the first settles', async () => {
      // Regression: flushSave used to check pendingSnapshotRef only once right
      // after awaiting the prior save. If two callers were waiting on that
      // same prior save, the first to resume could consume pendingSnapshotRef
      // and kick off a second save while the other observed an already-null
      // pendingSnapshotRef and returned true before the second save settled.
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let created: DocumentSnapshot | undefined
      await act(async () => {
        created = await result.current.createDocument('Second canvas')
      })

      // Intercept the rename write so the test controls exactly when each of
      // the two successive saves (first rename, then second rename) settles.
      const originalSave = store.index.setDocumentName.bind(store.index)
      let resolveFirstSave!: () => void
      let resolveSecondSave!: () => void
      let saveCallCount = 0
      store.index.setDocumentName = (input) => {
        saveCallCount += 1
        if (saveCallCount === 1) {
          return new Promise<void>((resolve) => {
            resolveFirstSave = () => {
              originalSave(input).then(resolve)
            }
          })
        }
        if (saveCallCount === 2) {
          return new Promise<void>((resolve) => {
            resolveSecondSave = () => {
              originalSave(input).then(resolve)
            }
          })
        }
        return originalSave(input)
      }

      // First rename starts save #1 (fire-and-forget, exactly like the real hook).
      act(() => {
        result.current.renameDocument('First rename')
      })
      expect(saveCallCount).toBe(1)

      // Second rename queues a new pending snapshot and starts a second
      // flush waiter that awaits the still-in-flight save #1.
      act(() => {
        result.current.renameDocument('Second rename')
      })

      // A concurrent switchDocument call is a third waiter on the same save #1.
      let switchSettled = false
      const switchPromise = result.current.switchDocument(created!.documentId).then(() => {
        switchSettled = true
      })

      // Settle save #1. This lets save #2 (carrying "Second rename") start.
      await act(async () => {
        resolveFirstSave()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(saveCallCount).toBe(2)
      // switchDocument must still be waiting — save #2 has not settled yet.
      expect(switchSettled).toBe(false)
      expect(await store.getDefaultDocumentId()).toBe(C1)

      // Now let save #2 settle and confirm switchDocument only proceeds after it does.
      await act(async () => {
        resolveSecondSave()
        await switchPromise
      })
      expect(switchSettled).toBe(true)
      expect(result.current.persistence.kind).toBe('saved')
      expect(result.current.snapshot?.documentId).toBe(created!.documentId)
      expect(await store.getDefaultDocumentId()).toBe(created!.documentId)
      const flushed = await store.load(C1)
      expect(flushed).toEqual({ ...snap, name: 'Second rename', updatedAt: expect.any(String) })
    })
  })

  describe('duplicateDocument', () => {
    it('creates a new canvas named "<name> (copy)", copies the Loro bytes, and switches to it', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      await loro.save(C1, realSnapshotWithElements([{ id: 'rect-1' }]))
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let duplicated: DocumentSnapshot | undefined
      await act(async () => {
        duplicated = await result.current.duplicateDocument()
      })

      expect(duplicated?.name).toBe('untitled (copy)')
      expect(duplicated?.documentId).not.toBe(C1)
      // switched to the duplicate
      expect(result.current.snapshot?.documentId).toBe(duplicated?.documentId)
      expect(await store.getDefaultDocumentId()).toBe(duplicated?.documentId)

      const copiedLoro = await loro.load(duplicated!.documentId)
      expect(copiedLoro.kind).toBe('ok')
      if (copiedLoro.kind === 'ok') {
        const doc = new Loro()
        doc.import(copiedLoro.snapshot)
        expect(doc.getList('elements').toJSON()).toEqual([{ id: 'rect-1' }])
      }
    })

    it('increments the numeric suffix when "(copy)" is already taken', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      await store.save({
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FD2',
        workspaceId: getBrowserWorkspaceId(),
        path: 'untitled-2',
        name: 'untitled (copy)',
        updatedAt: snap.updatedAt,
        kind: 'spatial' as const,
      })
      const loro = new FakeLoroStore()
      await loro.save(C1, realSnapshotWithElements([]))
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let duplicated: DocumentSnapshot | undefined
      await act(async () => {
        duplicated = await result.current.duplicateDocument()
      })

      expect(duplicated?.name).toBe('untitled (copy 2)')
    })

    it('flushes a pending rename before duplicating, so the copy is named from the latest title', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      await loro.save(C1, realSnapshotWithElements([]))
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      act(() => {
        result.current.renameDocument('Renamed before duplicate')
      })

      let duplicated: DocumentSnapshot | undefined
      await act(async () => {
        duplicated = await result.current.duplicateDocument()
      })

      expect(duplicated?.name).toBe('Renamed before duplicate (copy)')
    })

    it('rolls back the metadata row when the Loro write fails', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      await loro.save(C1, realSnapshotWithElements([]))
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      loro.shouldThrow = true
      let thrown: unknown
      await act(async () => {
        try {
          await result.current.duplicateDocument()
        } catch (err) {
          thrown = err
        }
      })
      expect(thrown).toBeDefined()

      const list = await store.listDocuments()
      expect(list).toHaveLength(1)
      expect(list[0].documentId).toBe(C1)
      // Never switched away from the source canvas on failure.
      expect(result.current.snapshot?.documentId).toBe(C1)
    })

    it('duplicating twice never mutates the original: editing the source after duplicating leaves the copy unchanged', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId(C1)
      await store.save(snap)
      const loro = new FakeLoroStore()
      await loro.save(C1, realSnapshotWithElements([{ id: 'original-element' }]))
      const { result } = renderHook(() =>
        useBrowserDocumentController(store.index, {
          loro: loro,
          pointer: store.pointer,
          clock: store.clock,
        }),
      )
      await act(async () => {})

      let duplicated: DocumentSnapshot | undefined
      await act(async () => {
        duplicated = await result.current.duplicateDocument()
      })

      // Edit the ORIGINAL's stored Loro bytes directly (simulating further
      // edits to the source canvas after duplicating) and confirm the
      // duplicate's already-copied bytes are untouched.
      const loadedOriginal = await loro.load(C1)
      if (loadedOriginal.kind !== 'ok') throw new Error('unexpected load failure')
      const originalDoc = new Loro()
      originalDoc.import(loadedOriginal.snapshot)
      originalDoc.getList('elements').push({ id: 'added-after-duplicate' })
      await loro.save(C1, originalDoc.export({ mode: 'snapshot' }))

      const copiedLoro = await loro.load(duplicated!.documentId)
      expect(copiedLoro.kind).toBe('ok')
      if (copiedLoro.kind === 'ok') {
        const doc = new Loro()
        doc.import(copiedLoro.snapshot)
        expect(doc.getList('elements').toJSON()).toEqual([{ id: 'original-element' }])
      }
    })
  })
})
