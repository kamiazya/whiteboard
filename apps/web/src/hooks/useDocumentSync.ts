import {
  createBrowserMeasureText,
  withViewerFontEmbedded,
} from '@kamiazya/whiteboard-canvas-viewer'
import { serializeSpatial } from '@kamiazya/whiteboard-codec'
import type { DocumentBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import type {
  CommentThread,
  DocumentKind,
  SpatialCanvas,
  StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentOutlineSource } from '../lib/document-outline.js'
import {
  type BackendErrorReason,
  createDocumentSyncSession,
  createGenerationCounters,
  type DocumentSyncSession,
} from '../lib/document-sync-session.js'
import type { SyncStatus, UseDocumentSyncOptions } from '../lib/document-sync-types.js'
import { dispatchIdentityEvent } from '../lib/document-sync-types.js'
import { embedTextInPng } from '../lib/png-embed.js'
import { rasterizeSvgToPng } from '../lib/rasterize-svg.js'
import type { EditorCommand } from '../lib/spatial/commands.js'
import { renderCanvasToSvg } from '../lib/spatial/scene-render.js'

export type { UseDocumentSyncOptions }
// Re-exported so existing call sites can keep importing it from the hook
// module; the canonical definition lives in lib/document-sync-types.ts
// alongside the session module that also needs it.
export { dispatchIdentityEvent }

// canvas-render's SVG backend + this hook's own Canvas-2D raster path are the
// only export routes now that Excalidraw's exportToBlob/exportToSvg are gone.
export type SceneExportFormat = 'png' | 'svg'

export interface UseDocumentSyncResult {
  syncStatus: SyncStatus
  backendError: BackendErrorReason | null
  /**
   * True once the backend has published this canvas's document at least
   * once. The document arrives AFTER mount, so anything deriving a decision
   * from the canvas's shape (its node count, say) must wait for this rather
   * than reading the empty placeholder the hook starts with.
   */
  loaded: boolean
  canvas: SpatialCanvas
  onChange: (next: SpatialCanvas, command: EditorCommand) => void
  // Bumps only on an externally-originated canvas publish (initial hydrate,
  // remote import, undo, redo) — never on this hook's own `onChange`. Passed
  // to SpatialEditor so it can tell "my own controlled re-render" apart from
  // "the canvas was replaced out from under an in-flight gesture" and cancel
  // the gesture only in the latter case.
  externalVersion: number
  restoreInProgress: boolean
  restoreLabel: string | null
  clearLocalUndo: () => void
  // Same Loro UndoManager the Cmd/Ctrl+Z keyboard path drives — exposed so
  // pointer surfaces (the canvas HistoryCluster) share one history. The
  // can* reads are live (recomputed each render), never cached state.
  undo: () => boolean
  redo: () => boolean
  canUndo: () => boolean
  /** Node ids locked in the doc's sidecar map (never part of the canvas value). */
  lockedNodeIds: ReadonlySet<string>
  setNodeLock: (nodeId: string, locked: boolean) => void
  /**
   * The doc's `body` text container — a markdown document's whole body, and
   * the ONE place it is stored (`wb_document_set` writes here too). Empty
   * string before the first snapshot; a caller that also needs to know
   * whether the document has hydrated reads `loaded`.
   */
  /**
   * This document's conversations (ADR-0026), published on their own channel
   * because a reply changes no node and no edge — a consumer watching only
   * `canvas` would never learn of one.
   */
  annotations: readonly CommentThread[]
  markdownBody: string
  /**
   * OKF core facets from the doc's `core` map — `undefined` for a spatial
   * document, which has none to hold. Republished on the same signal as
   * `markdownBody`: both live outside the canvas value and change together
   * on hydration, remote import and undo.
   */
  coreFacets: StoredCoreFacets | undefined
  setCoreFacets: (facets: StoredCoreFacets) => void
  /**
   * What a picture of this document would be drawn from, paired with the id
   * of the state it is. `null` until the first snapshot. See the callback for
   * why the two are read together rather than exposed separately.
   */
  readOutlineSource: (kind: DocumentKind) => DocumentOutlineSource | null
  /** OKF core facets from the doc's sidecar map; undefined until hydrated or when never written. */
  lockedEdgeIds: ReadonlySet<string>
  setEdgeLock: (edgeId: string, locked: boolean) => void
  canRedo: () => boolean
  // null when the requested format is unavailable in this environment (e.g.
  // 'png' with no real Canvas 2D context, such as jsdom) — callers treat
  // that the same as "export unavailable right now" rather than throwing.
  exportScene: (format: SceneExportFormat) => Promise<Blob | null>
}

/** Stable identity so an unlocked canvas never re-renders the editor. */
const EMPTY_LOCKED_IDS: ReadonlySet<string> = new Set()
const EMPTY_ANNOTATIONS: readonly CommentThread[] = []

const EMPTY_CANVAS: SpatialCanvas = { nodes: [], edges: [] }

function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}

/**
 * useDocumentSync — canonical sync hook for both the browser backend and
 * a daemon-backed connection.
 *
 * This hook is React glue only: state, the connect/teardown effect, and the
 * keyboard undo-redo intercept. All per-connection state (the LoroDoc, its
 * UndoManager, the debounced commit pipeline, queued export requests, and
 * the DocumentBackendHandlers wiring) lives in a `DocumentSyncSession` from
 * `../lib/document-sync-session.js` — a plain non-React module constructed
 * fresh for every backend identity. This hook mirrors the session's
 * published canvas value into React state via `session.subscribe`, and
 * forwards `onChange(next, command)` — structurally the same signature as
 * `SpatialEditorProps['onChange']` — straight through to the session.
 *
 * Accepts a DocumentBackend (e.g. BrowserBackend) or null when no backend
 * is available yet (e.g. the initial snapshot is still loading). A null
 * backend never connects: syncStatus stays 'idle', canvas stays the empty
 * canvas, and onChange is a no-op. When the backend identity changes —
 * including null-to-backend and backend-to-backend — the previous session
 * is fully disposed before the new one connects. This is the mechanism a
 * browser -> daemon in-place migration rides on: swapping the
 * DocumentBackend prop is the whole contract.
 *
 * `options` wires the daemon-only capability receptors (onVersionCreated,
 * onHeadChanged) plus the restore-overlay state and
 * onViewportRequest/onExportRequest/onAuthError handling that a daemon
 * backend can drive. A browser backend never fires any of these
 * events, so passing no `options` behaves exactly as before this seam was
 * added.
 *
 * Ref discipline: every ref below is intentionally mutable per-hook-instance
 * state that is never shared across components. The generation counters
 * deliberately outlive any individual session (see
 * `createGenerationCounters`'s doc comment) — they are the one piece of
 * per-connection-adjacent state that stays hook-owned rather than moving
 * into the session, precisely so staleness detection can span a session
 * teardown + the next session's construction.
 */
export function useDocumentSync(
  backend: DocumentBackend | null,
  options?: UseDocumentSyncOptions,
): UseDocumentSyncResult {
  // Latest-prop mirrors deliberately excluded from the connect effect's
  // dependency array below: reading `backend`/`options` through these refs
  // (rather than as effect deps) means a fresh inline object passed on every
  // render never forces a reconnect.
  const backendRef = useRef<DocumentBackend | null>(backend)
  backendRef.current = backend
  const optionsRef = useRef<UseDocumentSyncOptions>(options ?? {})
  optionsRef.current = options ?? {}

  // Handle to the live extracted session (null when backend is null / no
  // session has been created yet).
  const sessionRef = useRef<DocumentSyncSession | null>(null)

  // Hook-owned (not session-owned) generation counters — see this hook's
  // doc comment and `createGenerationCounters` for why they must survive a
  // session swap within this hook instance rather than resetting per session.
  const generationsRef = useRef(createGenerationCounters())

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  /**
   * Why the last backend failure happened, or null.
   *
   * Kept beside `syncStatus` rather than folded into it: 'error' answers
   * whether the editor is live, and this answers what to tell the user about
   * their document — which for an unreadable one is the opposite of "it is
   * empty".
   */
  const [backendError, setBackendError] = useState<BackendErrorReason | null>(null)
  const [canvas, setCanvas] = useState<SpatialCanvas>(EMPTY_CANVAS)
  const [loaded, setLoaded] = useState(false)
  const [externalVersion, setExternalVersion] = useState(0)
  // Render signal only — the value itself is never read.
  const [, setHistoryVersion] = useState(0)
  /**
   * This document's conversations (ADR-0026). Frozen empty default so an
   * unhydrated render and a document with no comments are the same value,
   * and neither re-renders a consumer that memoises on it.
   */
  const [annotations, setAnnotations] = useState<readonly CommentThread[]>(EMPTY_ANNOTATIONS)
  const [lockedNodeIds, setLockedNodeIds] = useState<ReadonlySet<string>>(EMPTY_LOCKED_IDS)
  const [markdownBody, setMarkdownBodyState] = useState('')
  const [coreFacets, setCoreFacetsState] = useState<StoredCoreFacets | undefined>(undefined)
  const [lockedEdgeIds, setLockedEdgeIds] = useState<ReadonlySet<string>>(EMPTY_LOCKED_IDS)
  const [restoreInProgress, setRestoreInProgress] = useState(false)
  const [restoreLabel, setRestoreLabel] = useState<string | null>(null)

  // Backend connect/disconnect lifecycle. Depends on `backend` identity so a
  // prop swap (including to/from null) tears down the previous session —
  // via this effect's own cleanup running before the next run's body — and
  // establishes a fresh one instead of connecting once to whatever backend
  // was first passed in.
  useEffect(() => {
    // A restore in flight against the session being torn down (backend
    // switch or disconnect) belongs to that session alone — leaving these
    // set would permanently stick the restore overlay to a defunct restore
    // even though the new session (or no session) is not restoring anything.
    setRestoreInProgress(false)
    setRestoreLabel(null)
    setCanvas(EMPTY_CANVAS)
    setLoaded(false)
    // Locks belong to the session being torn down. Left standing they would
    // be reported against whatever canvas comes next — or against nothing at
    // all, when the backend goes to null.
    setLockedNodeIds(EMPTY_LOCKED_IDS)
    setLockedEdgeIds(EMPTY_LOCKED_IDS)
    // Conversations belong to the session being torn down, exactly as the
    // locks do — left standing they would be listed against whatever document
    // is next, and with no successor session (backend going to null) nothing
    // would ever publish over them.
    setAnnotations(EMPTY_ANNOTATIONS)
    // The body belongs to the session being torn down, exactly as the locks
    // do — left standing it would render against whatever document is next.
    setMarkdownBodyState('')
    setCoreFacetsState(undefined)
    // And the failure reason, for the same reason and with a sharper
    // consequence: it describes ONE document, and carried across a switch it
    // turns the next one — which may be perfectly readable — into an error
    // screen the page cannot distinguish from a real failure.
    setBackendError(null)

    if (backend === null) {
      sessionRef.current = null
      setSyncStatus('idle')
      // Bumps the connection generation even though no new session is
      // created, mirroring the pre-extraction hook's unconditional bump on
      // every effect run. Without this, a settling async op from the
      // just-disposed session would still match its own myGeneration (no
      // successor session ever advances the counter for a switch-to-null).
      generationsRef.current.nextConnectionGeneration()
      return
    }

    const session = createDocumentSyncSession(backend, {
      getOptions: () => optionsRef.current,
      onStatusChange: setSyncStatus,
      onBackendError: setBackendError,
      onRestoreChange: (inProgress, label) => {
        setRestoreInProgress(inProgress)
        setRestoreLabel(label)
      },
      dispatchIdentityEvent,
      generations: generationsRef.current,
      // Captured once per session, deliberately: the scope names the document
      // this backend serves, and a scope that moved without the backend
      // moving would silently retarget writes mid-session.
      ...(optionsRef.current.contentDocumentId === undefined
        ? {}
        : { contentDocumentId: optionsRef.current.contentDocumentId }),
    })
    sessionRef.current = session
    const unsubscribe = session.subscribe((next, origin) => {
      setCanvas(next)
      setLoaded(true)
      if (origin === 'external') setExternalVersion((v) => v + 1)
    })
    // Undo-stack pushes land on COMMIT, after the canvas publish that drove
    // the consumer's last render — bump a version so canUndo/canRedo reads
    // re-run when the stack changes shape.
    const unsubscribeHistory = session.subscribeHistory(() => setHistoryVersion((v) => v + 1))
    // A lock changes no canvas value, so it has its own notification —
    // without it the editor would keep rendering a stale locked set.
    const unsubscribeLocks = session.subscribeLocks(() => {
      setLockedNodeIds(session.getNodeLocks())
      setLockedEdgeIds(session.getEdgeLocks())
    })
    // A reply changes no canvas value at all — no node, no edge — so the
    // annotation layer needs its own notification for the same reason locks
    // and the body do.
    const unsubscribeAnnotations = session.subscribeAnnotations((threads) => {
      setAnnotations(threads)
    })
    // The body changes no canvas value either, so it needs its own
    // notification for the same reason locks do.
    const unsubscribeBody = session.subscribeMarkdownBody(() => {
      setMarkdownBodyState(session.getMarkdownBody())
      setCoreFacetsState(session.getCoreFacets())
    })
    // Seed from the session as well as subscribing: hydration can complete
    // BEFORE this effect runs (the backend may deliver a snapshot
    // synchronously), and a missed notification would otherwise leave a
    // persisted lock invisible until the next toggle.
    setLockedNodeIds(session.getNodeLocks())
    setLockedEdgeIds(session.getEdgeLocks())
    setAnnotations(session.getAnnotations())
    session.connect()
    session.onEditorReady()

    return () => {
      unsubscribe()
      unsubscribeHistory()
      unsubscribeAnnotations()
      unsubscribeLocks()
      unsubscribeBody()
      session.dispose()
    }
  }, [backend])

  const loroUndo = useCallback(() => {
    return sessionRef.current?.undo() ?? false
  }, [])

  const loroRedo = useCallback(() => {
    return sessionRef.current?.redo() ?? false
  }, [])

  const clearLocalUndo = useCallback(() => {
    sessionRef.current?.clearUndo()
  }, [])

  /**
   * What a picture of this document would be drawn from, with the id of the
   * state it is — read TOGETHER.
   *
   * Both reads happen in this one synchronous block, which is the whole
   * point of returning a pair rather than two accessors: nothing can commit
   * between them, so the bytes and the version cannot describe different
   * states. Handing a caller two functions instead would let it read the
   * body after an edit and the version before it, and file the new picture
   * under the old key — which serves the previous picture for as long as
   * that key stands.
   *
   * `null` until the first snapshot: the absence of a version, which the
   * broker declines to remember anything under.
   */
  const readOutlineSource = useCallback(
    (documentKind: DocumentKind): DocumentOutlineSource | null => {
      const session = sessionRef.current
      if (session === null) return null
      const state = session.getContentState()
      if (state === null) return null
      if (documentKind === 'markdown') return { state, body: session.getMarkdownBody() }
      const snapshot = session.exportSnapshot()
      return snapshot === null ? null : { state, snapshot }
    },
    [],
  )

  // Live affordance state for undo/redo buttons. Not memoized state: every
  // publish re-renders the consumer (setCanvas above), so reading through
  // the session on each render is always current and never stale.
  const setEdgeLock = useCallback((edgeId: string, locked: boolean) => {
    sessionRef.current?.setEdgeLock(edgeId, locked)
  }, [])

  const setCoreFacets = useCallback((facets: StoredCoreFacets) => {
    const session = sessionRef.current
    if (session === undefined || session === null) return
    session.onChange(session.getCanvas(), { kind: 'set-facets', facets })
  }, [])

  const setNodeLock = useCallback((nodeId: string, locked: boolean) => {
    sessionRef.current?.setNodeLock(nodeId, locked)
  }, [])

  const canUndo = useCallback(() => {
    return sessionRef.current?.canUndo() ?? false
  }, [])

  const canRedo = useCallback(() => {
    return sessionRef.current?.canRedo() ?? false
  }, [])

  // Derives the export blob from the hook-owned canvas value — no imperative
  // editor handle involved, so exportScene works identically whether or not
  // a SpatialEditor is currently mounted.
  const exportScene = useCallback(
    async (format: SceneExportFormat): Promise<Blob | null> => {
      const exportedCanvas = sessionRef.current?.getCanvas() ?? canvas
      const { svg, bounds } = renderCanvasToSvg(exportedCanvas, {
        measure: createBrowserMeasureText(),
        // Pinned to 'light' regardless of the UI theme: an exported SVG/PNG
        // is a saved artifact, and a user's display preference must never
        // change its bytes.
        theme: 'light',
      })
      if (format === 'svg') {
        return new Blob([svg], { type: 'image/svg+xml' })
      }
      // The face has to travel INSIDE the document: `ensureViewerFontLoaded`
      // registers it on this page, and an `<img>`-rendered SVG cannot see the
      // page's fonts, so without this the exported PNG is drawn in whatever
      // system font the browser picks — not the one on screen.
      const png = await rasterizeSvgToPng(
        await withViewerFontEmbedded(svg),
        Math.max(1, Math.round(bounds.w)),
        Math.max(1, Math.round(bounds.h)),
      )
      if (png === null) return null
      // Editable PNG (the draw.io pattern): embed the extended JSON Canvas
      // document in an iTXt chunk, so the exported image carries its own
      // source — exact coordinates included — under the `whiteboard` key.
      const bytes = new Uint8Array(await png.arrayBuffer())
      const embedded = embedTextInPng(
        bytes,
        'whiteboard',
        serializeSpatial(exportedCanvas, 'extended'),
      )
      // Copy into a fresh ArrayBuffer-backed view: Blob's lib.dom typing
      // rejects ArrayBufferLike-backed Uint8Arrays.
      return new Blob([Uint8Array.from(embedded)], { type: 'image/png' })
    },
    [canvas],
  )

  // Keyboard intercept for undo/redo — SpatialEditor has no undo/redo buttons
  // of its own, so the keyboard is the only entry point.
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent): void {
      if (!(ev.ctrlKey || ev.metaKey)) return
      if (isEditingText(ev.target)) return
      const key = ev.key.toLowerCase()
      if (key === 'z' && !ev.shiftKey) {
        if (loroUndo()) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      } else if ((key === 'z' && ev.shiftKey) || key === 'y') {
        if (loroRedo()) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [loroUndo, loroRedo])

  const onChange = useCallback((next: SpatialCanvas, command: EditorCommand) => {
    sessionRef.current?.onChange(next, command)
  }, [])

  return {
    syncStatus,
    backendError,
    loaded,
    canvas,
    onChange,
    externalVersion,
    restoreInProgress,
    restoreLabel,
    clearLocalUndo,
    undo: loroUndo,
    redo: loroRedo,
    canUndo,
    lockedNodeIds,
    setNodeLock,
    annotations,
    markdownBody,
    coreFacets,
    setCoreFacets,
    readOutlineSource,
    lockedEdgeIds,
    setEdgeLock,
    canRedo,
    exportScene,
  }
}
