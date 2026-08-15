/**
 * The CRDT-binding half of the markdown document hook: the loaded Loro
 * instance is exposed so the composition root can bind CodeMirror to it
 * (loro-codemirror), and doc changes committed OUTSIDE setBody — exactly
 * what the binding produces — still refresh the body state and schedule a
 * save. Without that, a binding-driven edit would be on screen and in the
 * CRDT but never persisted and never reflected in the preview.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import type { Loro } from 'loro-crdt'
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
    // the next effect run loads the same canvasId. Unordered, the load can
    // read the store BEFORE that flush lands — the reloaded doc then shows
    // pre-edit state and the debounce that held the edit is gone, so it is
    // lost for good. Captured live as a title typed into the real page
    // coming back '' after a remount. The store here makes the race
    // deterministic: save parks on a gate the test opens only after the
    // reload has started.
    const saves: Uint8Array[] = []
    let releaseSave: () => void = () => {}
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    let saved: Uint8Array | null = null
    const store: LoroStoreLike = {
      async save(_canvasId, snapshot) {
        await saveGate
        saved = snapshot
        saves.push(snapshot)
      },
      createEmptySnapshot() {
        return new Uint8Array()
      },
      async load() {
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
      result.current.setCoreMeta({ type: 'note', title: 'リリース計画' })
    })
    expect(result.current.coreMeta?.title).toBe('リリース計画')

    // Cycle the effect while the debounce still holds the edit — the shape
    // any transient enabled/canvasId flicker produces.
    rerender({ enabled: false })
    rerender({ enabled: true })
    // Let the reload start against the un-flushed store, THEN land the save.
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseSave()

    await waitFor(() => expect(result.current.doc).not.toBeNull())
    await waitFor(() => expect(result.current.coreMeta?.title).toBe('リリース計画'), {
      timeout: 3000,
    })
    expect(saves.length).toBeGreaterThan(0)
  })
})
