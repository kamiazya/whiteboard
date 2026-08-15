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
