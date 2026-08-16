/**
 * The CRDT-binding half of the markdown document hook: the loaded Loro
 * instance is exposed so the composition root can bind CodeMirror to it
 * (loro-codemirror), and doc changes committed OUTSIDE setBody — exactly
 * what the binding produces — still refresh the body state and schedule a
 * save. Without that, a binding-driven edit would be on screen and in the
 * CRDT but never persisted and never reflected in the preview.
 */
import {
  MARKDOWN_BODY_KEY,
  MARKDOWN_BODY_NODE_ID,
  readMarkdownBody,
  readSpatialCanvas,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-workspace'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type Loro, LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LoroStoreLike } from './use-browser-local-canvas-controller.js'
import { useMarkdownCanvasDoc } from './use-markdown-canvas-doc.js'

function fakeStore(): LoroStoreLike & { saves: Uint8Array[] } {
  const saves: Uint8Array[] = []
  return {
    saves,
    async save(_canvasId, snapshot) {
      saves.push(snapshot)
    },
    createEmptySnapshot() {
      return new Uint8Array()
    },
    async load() {
      return { kind: 'missing' } as never
    },
  }
}

describe('useMarkdownCanvasDoc CRDT exposure', () => {
  // Real timers throughout: the doc subscription delivers on the microtask
  // queue and the save debounce is 500ms — condition-waiting on both beats
  // fake-timer choreography (see the fake-timers-vs-threadpool flake class).

  it('exposes the loaded Loro doc for composition-root bindings', async () => {
    const store = fakeStore()
    const { result } = renderHook(() => useMarkdownCanvasDoc(store, 'c1', true))
    expect(result.current.doc).toBeNull()
    await waitFor(() => expect(result.current.doc).not.toBeNull())
  })

  it('refreshes body state and schedules a save for a commit made outside setBody', async () => {
    const store = fakeStore()
    const { result } = renderHook(() => useMarkdownCanvasDoc(store, 'c1', true))
    await waitFor(() => expect(result.current.doc).not.toBeNull())

    // What the loro-codemirror binding does on a keystroke: mutate the text
    // container and commit — never through setBody.
    const doc = result.current.doc as Loro
    await act(async () => {
      doc.getText('body').insert(0, 'typed via binding')
      doc.commit()
    })

    await waitFor(() => expect(result.current.body).toBe('typed via binding'))
    await waitFor(() => expect(store.saves.length).toBeGreaterThan(0), { timeout: 3000 })
  })
})

describe('flush/load ordering across an effect cycle', () => {
  it('a reload sees the edits the unmount flush was still writing', async () => {
    // The cleanup flushes the pending debounce with a fire-and-forget save;
    // the next effect run loads the same documentId. Unordered, the load can
    // read the store BEFORE that flush lands — the reloaded doc then shows
    // pre-edit state and the debounce that held the edit is gone, so it is
    // lost for good. Captured live as a title typed into the real page
    // coming back '' after a remount. The store here makes the race
    // deterministic: save parks on a gate the test opens only after the
    // reload has started, and the ordering is asserted from a log rather
    // than inferred from a delay.
    const log: string[] = []
    const saves: Uint8Array[] = []
    let releaseSave: () => void = () => {}
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    let saved: Uint8Array | null = null
    const store: LoroStoreLike = {
      async save(_canvasId, snapshot) {
        log.push('save-start')
        await saveGate
        saved = snapshot
        saves.push(snapshot)
        log.push('save-end')
      },
      createEmptySnapshot() {
        return new Uint8Array()
      },
      async load() {
        log.push('load')
        if (saved === null) return { kind: 'missing' } as never
        return { kind: 'ok', snapshot: saved, deltas: [] } as never
      },
    }

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMarkdownCanvasDoc(store, 'c1', enabled),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current.doc).not.toBeNull())

    act(() => {
      result.current.setCoreFacets({ type: 'note', tags: ['リリース計画'] })
    })
    expect(result.current.coreFacets?.tags).toEqual(['リリース計画'])

    // Cycle the effect while the debounce still holds the edit — the shape
    // any transient enabled/documentId flicker produces.
    rerender({ enabled: false })
    rerender({ enabled: true })
    // One macrotask tick, not a guessed delay: the load effect chains off the
    // pending-save map through microtasks, so an unguarded load has already
    // read the store by the time this resolves. The assertion below is on the
    // resulting ORDER, so a slower machine cannot turn a broken build green.
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseSave()

    await waitFor(() => expect(result.current.doc).not.toBeNull())
    await waitFor(() => expect(result.current.coreFacets?.tags).toEqual(['リリース計画']), {
      timeout: 3000,
    })
    expect(saves.length).toBeGreaterThan(0)
    // Two loads: the mount's, then the reload under test — which must come
    // after the flush landed.
    await waitFor(() => expect(log.filter((entry) => entry === 'load')).toHaveLength(2), {
      timeout: 3000,
    })
    expect(log.lastIndexOf('load')).toBeGreaterThan(log.indexOf('save-end'))
  })

  it('a reload waits for a debounce save that already started', async () => {
    // The sibling above covers the save the CLEANUP starts. This covers the
    // one the debounce TIMER starts: once it fires it clears the timer ref,
    // so a later unmount registers no flush at all and the next load has
    // nothing to wait on. Same ending — the load reads the pre-edit store
    // and the edit is gone — reached through the path the cleanup fix does
    // not cover.
    //
    // Asserted as an ORDER, not a delay: the store logs when each save
    // starts and lands and when a load reads it, and `load` must never sit
    // between a save's start and its landing. A sleep would only say "it
    // happened to be fast enough here".
    const log: string[] = []
    let releaseSave: () => void = () => {}
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    let saved: Uint8Array | null = null
    const store: LoroStoreLike = {
      async save(_canvasId, snapshot) {
        log.push('save-start')
        await saveGate
        saved = snapshot
        log.push('save-end')
      },
      createEmptySnapshot() {
        return new Uint8Array()
      },
      async load() {
        log.push('load')
        if (saved === null) return { kind: 'missing' } as never
        return { kind: 'ok', snapshot: saved, deltas: [] } as never
      },
    }

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMarkdownCanvasDoc(store, 'c1', enabled),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current.doc).not.toBeNull())

    act(() => {
      result.current.setBody('typed before the switch')
    })

    // Let the debounce actually FIRE — that is the state this test is about,
    // and it is what leaves the cleanup with no timer to flush.
    await waitFor(() => expect(log).toContain('save-start'), { timeout: 3000 })

    rerender({ enabled: false })
    rerender({ enabled: true })

    // One macrotask tick. The load effect chains off `pendingFlushes` through
    // microtasks, so an unguarded load has already read the store by the time
    // this resolves — the ordering below then fails deterministically rather
    // than by luck.
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseSave()

    // Two loads happen in total: the mount's, then the reload under test.
    await waitFor(() => expect(log.filter((entry) => entry === 'load')).toHaveLength(2), {
      timeout: 3000,
    })
    expect(log.lastIndexOf('load')).toBeGreaterThan(log.indexOf('save-end'))
    await waitFor(() => expect(result.current.body).toBe('typed before the switch'), {
      timeout: 3000,
    })
  })
})

describe('a document written by the daemon-side writer', () => {
  // `wb_document_set` used to store a body as an `okf-body` TEXT NODE rather
  // than the `body` text container this editor binds to. Documents written
  // that way are still in stores, so both sides read through
  // `readMarkdownBody`; this editor reading the raw container instead showed
  // such a document as empty and then quietly overwrote it.
  function storeHolding(build: (doc: Loro) => void): LoroStoreLike & { saves: Uint8Array[] } {
    const doc = new LoroDoc()
    build(doc)
    const snapshot = doc.export({ mode: 'snapshot' })
    const saves: Uint8Array[] = []
    return {
      saves,
      async save(_canvasId, next) {
        saves.push(next)
      },
      createEmptySnapshot() {
        return new Uint8Array()
      },
      async load() {
        return { kind: 'ok', snapshot, deltas: [] } as never
      },
    }
  }

  const legacy = (doc: Loro) => {
    writeSpatialCanvas(doc, {
      nodes: [
        {
          id: MARKDOWN_BODY_NODE_ID,
          type: 'text',
          x: 0,
          y: 0,
          width: 600,
          height: 400,
          text: 'written by wb_document_set',
        },
      ],
      edges: [],
    })
    doc.commit()
  }

  it('opens with its body visible instead of empty', async () => {
    const store = storeHolding(legacy)
    const { result } = renderHook(() => useMarkdownCanvasDoc(store, 'c1', true))

    await waitFor(() => expect(result.current.body).toBe('written by wb_document_set'))
  })

  it('converges it onto the text container, which is all the CRDT binding can bind to', async () => {
    // Reading the node is not enough. `LoroSyncPlugin` binds CodeMirror to
    // the `body` CONTAINER, so a document that leaves its prose in a node
    // opens with text in the preview and an empty editor.
    const store = storeHolding(legacy)
    const { result } = renderHook(() => useMarkdownCanvasDoc(store, 'c1', true))
    await waitFor(() => expect(result.current.doc).not.toBeNull())

    const doc = result.current.doc as Loro
    await waitFor(() =>
      expect(doc.getText(MARKDOWN_BODY_KEY).toString()).toBe('written by wb_document_set'),
    )
    expect(readSpatialCanvas(doc).nodes).toEqual([])
    // And persisted, so the conversion survives the next load rather than
    // being redone from the node every time.
    await waitFor(() => expect(store.saves.length).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('does not resurrect the old body when the document is emptied', async () => {
    // The failure this pins is specific to keeping both representations
    // alive at once: an edit writes the container, the container wins on
    // read, and then clearing it falls back to the node nobody removed — so
    // deleted text reappears. Stated as the outcome rather than as one
    // mechanism, because either superseding the node on load or on write is
    // enough; what must not happen is neither.
    const store = storeHolding(legacy)
    const { result } = renderHook(() => useMarkdownCanvasDoc(store, 'c1', true))
    await waitFor(() => expect(result.current.body).toBe('written by wb_document_set'))

    act(() => {
      result.current.setBody('replaced')
    })
    act(() => {
      result.current.setBody('')
    })

    expect(result.current.body).toBe('')
    expect(readMarkdownBody(result.current.doc as Loro)).toBe('')
  })
})
