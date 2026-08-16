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
import type { StoredCoreFacets } from '@kamiazya/whiteboard-canvas-model'
import {
  MARKDOWN_BODY_KEY,
  readCoreFacets,
  readMarkdownBody,
  writeCoreFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-canvas-workspace'
import { Loro } from 'loro-crdt'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoroStoreLike } from './use-browser-local-canvas-controller.js'

const pendingFlushes = new Map<string, Promise<unknown>>()

const SAVE_DEBOUNCE_MS = 500

/**
 * Every save for a document goes through one queue, and the load effect
 * awaits it. Two invariants ride on that:
 *
 * - A load must not read the store while a save it should see is in flight,
 *   or it reloads pre-edit state and the edit is gone (the debounce that
 *   held it is already spent).
 * - Two saves must not land out of order. Each is a full snapshot export, so
 *   an earlier one landing last puts the document back to where it was.
 *
 * Keyed per document and module-level because the writers that need to share
 * it — a cleanup closure and the next effect instance — share nothing else.
 * Never rejects: a failed save is swallowed here exactly as a fire-and-forget
 * one was, so it cannot leave the queue permanently poisoned.
 */
function queueSave(store: LoroStoreLike, canvasId: string, snapshot: Uint8Array): Promise<void> {
  const previous = pendingFlushes.get(canvasId)
  const next = Promise.resolve(previous)
    .then(() => store.save(canvasId, snapshot))
    .catch(() => {})
    .finally(() => {
      if (pendingFlushes.get(canvasId) === next) pendingFlushes.delete(canvasId)
    })
  pendingFlushes.set(canvasId, next)
  return next
}

/**
 * `type` is the one required core facet, so a canvas with nothing stored
 * still needs a value before anything can be written. It names what the
 * document IS rather than how it is stored — but a markdown note starting
 * as `markdown` is both true and the least surprising default, and the
 * field is free text the moment the user disagrees.
 */
export const DEFAULT_MARKDOWN_CORE_FACETS: StoredCoreFacets = { type: 'markdown' }

export interface MarkdownCanvasDocState {
  /** Null until the initial load resolves — render nothing editable before. */
  readonly body: string | null
  readonly setBody: (next: string) => void
  /** Null until the initial load resolves, mirroring `body`. */
  readonly coreFacets: StoredCoreFacets | null
  readonly setCoreFacets: (next: StoredCoreFacets) => void
  /**
   * The loaded Loro instance, for composition-root CRDT bindings
   * (loro-codemirror). Null until the initial load resolves. A binding
   * mutates the 'body' text container and commits directly — the doc
   * subscription below is what keeps `body` state and the save schedule in
   * step with commits this hook did not make.
   */
  readonly doc: Loro | null
}

export function useMarkdownCanvasDoc(
  loro: LoroStoreLike,
  canvasId: string | null,
  enabled: boolean,
): MarkdownCanvasDocState {
  const [body, setBodyState] = useState<string | null>(null)
  const [coreFacets, setCoreMetaState] = useState<StoredCoreFacets | null>(null)
  const [doc, setDoc] = useState<Loro | null>(null)
  const docRef = useRef<Loro | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loroRef = useRef(loro)
  loroRef.current = loro

  // See queueSave: the load below awaits whatever save is still in flight
  // for this document before reading the store.
  const pending = pendingFlushes

  useEffect(() => {
    if (!enabled || canvasId === null) {
      docRef.current = null
      setDoc(null)
      setBodyState(null)
      setCoreMetaState(null)
      return
    }
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void Promise.resolve(pending.get(canvasId))
      .catch(() => {})
      .then(() => loroRef.current.load(canvasId))
      .then((result) => {
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
        // Subscribed AFTER the initial import, so loading never schedules a
        // save of what was just loaded. This is how commits made OUTSIDE
        // setBody — a CRDT binding mutating the 'body' container directly —
        // still reach the body state (and the preview) and get persisted.
        unsubscribe = doc.subscribe((event) => {
          if (cancelled) return
          setBodyState(readMarkdownBody(doc))
          setCoreMetaState(readCoreFacets(doc) ?? DEFAULT_MARKDOWN_CORE_FACETS)
          if (event.by === 'local') scheduleSaveRef.current?.()
        })
        setDoc(doc)
        // A document written before the writers were unified stores its body
        // as a text NODE, and reading it is not enough: `LoroSyncPlugin`
        // syncs the text CONTAINER into CodeMirror on mount and overwrites
        // whatever `value` put there, so such a document settles on an empty
        // editor beside a preview showing its prose — and the next keystroke
        // saves over the original. Converting on load is what ends that.
        //
        // Here rather than in a migration pass because this is the moment the
        // document is in memory anyway, and it is a no-op for every document
        // already in the current shape. The write commits locally, so the
        // subscription above both refreshes the state and persists it.
        const stored = readMarkdownBody(doc)
        if (stored.length > 0 && doc.getText(MARKDOWN_BODY_KEY).length === 0) {
          writeMarkdownBody(doc, stored)
        }
        setBodyState(readMarkdownBody(doc))
        setCoreMetaState(readCoreFacets(doc) ?? DEFAULT_MARKDOWN_CORE_FACETS)
      })
    return () => {
      cancelled = true
      unsubscribe?.()
      // FLUSH, not cancel. A pending debounce holds edits that are already in
      // the document and already on screen; dropping it loses whatever was
      // typed in the last 500ms before a canvas switch or unmount. For the
      // title that is worse than lost text: `renameCanvas` writes the
      // snapshot name immediately, so a cancelled facet save leaves the list
      // name and the OKF title disagreeing about what the document is called.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        const doc = docRef.current
        if (doc !== null && canvasId !== null) {
          void queueSave(loroRef.current, canvasId, doc.export({ mode: 'snapshot' }))
        }
      }
    }
  }, [canvasId, enabled])

  // One timer for both writers: they export the same document, so a second
  // independent debounce would only duplicate the save. Reached through a
  // ref from the doc subscription, which is created inside the load effect
  // before this binding initializes on the first render.
  const scheduleSaveRef = useRef<(() => void) | null>(null)
  const scheduleSave = useCallback(() => {
    if (canvasId === null) return
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      // Clearing the ref first means a cleanup arriving after this point
      // finds no timer to flush — so this save has to enqueue itself, or the
      // next load has nothing to wait on.
      timerRef.current = null
      const doc = docRef.current
      if (doc === null) return
      void queueSave(loroRef.current, canvasId, doc.export({ mode: 'snapshot' }))
    }, SAVE_DEBOUNCE_MS)
  }, [canvasId])
  scheduleSaveRef.current = scheduleSave

  const setBody = useCallback(
    (next: string) => {
      const doc = docRef.current
      if (doc === null) return
      setBodyState(next)
      // Replace-wholesale is deliberate for slice 1: the editor is a plain
      // textarea, so we do not have edit deltas to splice. CRDT-granular
      // updates arrive with the collaborative-editor slice.
      writeMarkdownBody(doc, next)
      scheduleSave()
    },
    [scheduleSave],
  )

  const setCoreFacets = useCallback(
    (next: StoredCoreFacets) => {
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

  return { body, setBody, coreFacets, setCoreFacets, doc }
}
