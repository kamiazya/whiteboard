/**
 * What the markdown editor is bound to while the NEXT document is still
 * loading.
 *
 * The load effect guards its own result with `cancelled`, flushes the
 * outgoing document's debounce on cleanup, and unsubscribes — all correct.
 * What it does not do is clear what is on screen BEFORE the async load: `doc`
 * and `body` are reset only when `documentId` becomes null, never when it
 * changes from one document to another. `hostRef.current` is the same story —
 * the cleanup sets `cancelled`, not the ref.
 *
 * So for the whole duration of the next document's load, the hook is still
 * holding the previous document's host and content under the new document's
 * address. `setBody` writes through `hostRef.current`, and `scheduleSave`
 * keys its scheduler on the NEW id, so a keystroke in that window is written
 * into the previous document and queued under the next one's name.
 *
 * Both sibling screens already keep the opposite rule and say why:
 * `DaemonIndexPage` clears rows "synchronously BEFORE the async load ...
 * leaving the previous workspace's rows visible during the switch lets a
 * click pair the new workspace id with an old workspace's path", and
 * `VersionTimeline` drops its rows "immediately on canvas change so a stale
 * row ... never renders under the new canvas while the refetch is in flight".
 */
import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { LoroStoreLike } from './use-browser-document-controller.js'
import { useMarkdownDocument } from './use-markdown-document.js'

/** Debounce the hook's scheduler uses; waited out rather than faked. */
const SAVE_DEBOUNCE_MS = 500

interface GatedStore extends LoroStoreLike {
  /** Every save, with the id it was addressed to. */
  saves: { id: string; snapshot: Uint8Array }[]
  /** Lets the held-open load for `heldId` finish. */
  release: () => void
  /** Resolves once that load has actually been requested. */
  requested: Promise<void>
}

/**
 * A store whose load for ONE id never settles until released, so a test can
 * stand inside the window where the next document is still loading and the
 * hook is still holding the previous one. Every other id loads immediately,
 * which is what lets the first document arrive normally.
 */
function gatedStore(heldId: string): GatedStore {
  const saves: { id: string; snapshot: Uint8Array }[] = []
  let release = (): void => {}
  let markRequested = (): void => {}
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    saves,
    release: () => release(),
    requested,
    async save(id, snapshot) {
      saves.push({ id, snapshot })
    },
    createEmptySnapshot() {
      return new Uint8Array()
    },
    async load(id) {
      if (id === heldId) {
        markRequested()
        await gate
      }
      return { kind: 'missing' } as never
    },
  } as GatedStore
}

describe('switching documents while the next one is still loading', () => {
  it('does not keep showing the previous document under the new address', async () => {
    const store = gatedStore('c2')
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useMarkdownDocument(store, id, true),
      { initialProps: { id: 'c1' } },
    )
    await waitFor(() => expect(result.current.doc).not.toBeNull())
    await act(async () => {
      result.current.setBody('written in c1')
    })
    await waitFor(() => expect(result.current.body).toBe('written in c1'))

    rerender({ id: 'c2' })
    await store.requested

    expect(
      result.current.body,
      'c2 is the document on screen, and this is c1’s prose — the editor is bound to the document that left',
    ).not.toBe('written in c1')
  })

  it('does not write a keystroke into the document that left', async () => {
    const store = gatedStore('c2')
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useMarkdownDocument(store, id, true),
      { initialProps: { id: 'c1' } },
    )
    await waitFor(() => expect(result.current.doc).not.toBeNull())

    rerender({ id: 'c2' })
    await store.requested
    store.saves.length = 0

    // A keystroke under c2's address, while c2 is still loading.
    await act(async () => {
      result.current.setBody('typed while c2 was loading')
    })
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS * 2))

    const intoC1 = store.saves.filter((s) => s.id === 'c1')
    expect(
      intoC1,
      'the keystroke was addressed at c1 — the hook still held its host while c2 loaded, so text typed under one document was written into another',
    ).toEqual([])

    store.release()
  })
})
