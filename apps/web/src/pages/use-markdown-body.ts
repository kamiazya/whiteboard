/**
 * Body state for a markdown-kind canvas, persisted through the SAME Loro
 * store the spatial canvases use — one storage path, no parallel metadata
 * (the snapshot row stays metadata-only per whiteboard-client.ts's rule).
 *
 * The body lives in the doc's 'body' text container. Loading tolerates every
 * LoroLoadResult failure by starting from an empty body: a markdown note the
 * store cannot decode should degrade to "empty, editable, next save
 * overwrites" rather than a dead page.
 */
import { Loro } from 'loro-crdt'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoroStoreLike } from './use-browser-local-canvas-controller.js'

const SAVE_DEBOUNCE_MS = 500

export interface MarkdownBodyState {
  /** Null until the initial load resolves — render nothing editable before. */
  readonly body: string | null
  readonly setBody: (next: string) => void
}

export function useMarkdownBody(
  loro: LoroStoreLike,
  canvasId: string | null,
  enabled: boolean,
): MarkdownBodyState {
  const [body, setBodyState] = useState<string | null>(null)
  const docRef = useRef<Loro | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loroRef = useRef(loro)
  loroRef.current = loro

  useEffect(() => {
    if (!enabled || canvasId === null) {
      docRef.current = null
      setBodyState(null)
      return
    }
    let cancelled = false
    void loroRef.current.load(canvasId).then((result) => {
      if (cancelled) return
      const doc = new Loro()
      if (result.kind === 'ok') {
        try {
          doc.import(result.snapshot)
          for (const delta of result.deltas ?? []) doc.import(delta)
        } catch {
          // degrade to empty — see module doc
        }
      }
      docRef.current = doc
      setBodyState(doc.getText('body').toString())
    })
    return () => {
      cancelled = true
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [canvasId, enabled])

  const setBody = useCallback(
    (next: string) => {
      const doc = docRef.current
      if (doc === null || canvasId === null) return
      setBodyState(next)
      // Replace-wholesale is deliberate for slice 1: the editor is a plain
      // textarea, so we do not have edit deltas to splice. CRDT-granular
      // updates arrive with the collaborative-editor slice.
      const text = doc.getText('body')
      text.delete(0, text.length)
      text.insert(0, next)
      doc.commit()
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void loroRef.current.save(canvasId, doc.export({ mode: 'snapshot' }))
      }, SAVE_DEBOUNCE_MS)
    },
    [canvasId],
  )

  return { body, setBody }
}
