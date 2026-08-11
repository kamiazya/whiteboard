/**
 * The whole document state for a markdown-kind canvas — body text plus OKF
 * core facets — persisted through the SAME Loro store the spatial canvases
 * use (the snapshot row stays metadata-only per whiteboard-client.ts's
 * rule).
 *
 * Body and facets share ONE `Loro` instance on purpose. They live in
 * different containers of the same document ('body' text, 'core' map), and
 * saving is a full `export({mode:'snapshot'})`; a second hook holding its
 * own instance for the same canvas would export a document missing the
 * other's container and silently overwrite it on the next debounce.
 *
 * Loading tolerates every LoroLoadResult failure by starting empty: a note
 * the store cannot decode should degrade to "empty, editable, next save
 * overwrites" rather than a dead page.
 */
import type { CanvasCoreMeta } from '@kamiazya/whiteboard-canvas-model'
import { readCoreFacets, writeCoreFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { Loro } from 'loro-crdt'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoroStoreLike } from './use-browser-local-canvas-controller.js'

const SAVE_DEBOUNCE_MS = 500

/**
 * `type` is the one required core facet, so a canvas with nothing stored
 * still needs a value before anything can be written. It names what the
 * document IS rather than how it is stored — but a markdown note starting
 * as `markdown` is both true and the least surprising default, and the
 * field is free text the moment the user disagrees.
 */
export const DEFAULT_MARKDOWN_CORE_META: CanvasCoreMeta = { type: 'markdown' }

export interface MarkdownCanvasDocState {
  /** Null until the initial load resolves — render nothing editable before. */
  readonly body: string | null
  readonly setBody: (next: string) => void
  /** Null until the initial load resolves, mirroring `body`. */
  readonly coreMeta: CanvasCoreMeta | null
  readonly setCoreMeta: (next: CanvasCoreMeta) => void
}

export function useMarkdownCanvasDoc(
  loro: LoroStoreLike,
  canvasId: string | null,
  enabled: boolean,
): MarkdownCanvasDocState {
  const [body, setBodyState] = useState<string | null>(null)
  const [coreMeta, setCoreMetaState] = useState<CanvasCoreMeta | null>(null)
  const docRef = useRef<Loro | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loroRef = useRef(loro)
  loroRef.current = loro

  useEffect(() => {
    if (!enabled || canvasId === null) {
      docRef.current = null
      setBodyState(null)
      setCoreMetaState(null)
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
      setCoreMetaState(readCoreFacets(doc) ?? DEFAULT_MARKDOWN_CORE_META)
    })
    return () => {
      cancelled = true
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [canvasId, enabled])

  // One timer for both writers: they export the same document, so a second
  // independent debounce would only duplicate the save.
  const scheduleSave = useCallback(() => {
    if (canvasId === null) return
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      const doc = docRef.current
      if (doc === null) return
      void loroRef.current.save(canvasId, doc.export({ mode: 'snapshot' }))
    }, SAVE_DEBOUNCE_MS)
  }, [canvasId])

  const setBody = useCallback(
    (next: string) => {
      const doc = docRef.current
      if (doc === null) return
      setBodyState(next)
      // Replace-wholesale is deliberate for slice 1: the editor is a plain
      // textarea, so we do not have edit deltas to splice. CRDT-granular
      // updates arrive with the collaborative-editor slice.
      const text = doc.getText('body')
      text.delete(0, text.length)
      text.insert(0, next)
      doc.commit()
      scheduleSave()
    },
    [scheduleSave],
  )

  const setCoreMeta = useCallback(
    (next: CanvasCoreMeta) => {
      const doc = docRef.current
      if (doc === null) return
      setCoreMetaState(next)
      // `writeCoreFacets` replaces the stored bucket outright, so `next` must
      // already be the complete meta — including `facetsRaw`. CanvasProperties
      // is what guarantees that; this hook does not re-merge.
      writeCoreFacets(doc, next)
      scheduleSave()
    },
    [scheduleSave],
  )

  return { body, setBody, coreMeta, setCoreMeta }
}
