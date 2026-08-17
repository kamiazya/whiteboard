import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { serializeSpatial } from '@kamiazya/whiteboard-codec'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { renderCanvasToSvg } from '../components/spatial-editor/scene-render.js'
import {
  type CanvasSyncSession,
  createCanvasSyncSession,
  createGenerationCounters,
} from '../lib/canvas-sync-session.js'
import type { SyncStatus, UseCanvasSyncOptions } from '../lib/canvas-sync-types.js'
import { dispatchIdentityEvent } from '../lib/canvas-sync-types.js'
import { embedTextInPng } from '../lib/png-embed.js'

export type { UseCanvasSyncOptions }
// Re-exported so existing call sites can keep importing it from the hook
// module; the canonical definition lives in lib/canvas-sync-types.ts
// alongside the session module that also needs it.
export { dispatchIdentityEvent }

// canvas-render's SVG backend + this hook's own Canvas-2D raster path are the
// only export routes now that Excalidraw's exportToBlob/exportToSvg are gone.
export type SceneExportFormat = 'png' | 'svg'

export interface UseCanvasSyncResult {
  syncStatus: SyncStatus
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
  markdownBody: string
  /**
   * OKF core facets from the doc's `core` map — `undefined` for a spatial
   * document, which has none to hold. Republished on the same signal as
   * `markdownBody`: both live outside the canvas value and change together
   * on hydration, remote import and undo.
   */
  coreFacets: StoredCoreFacets | undefined
  setCoreFacets: (facets: StoredCoreFacets) => void
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

const EMPTY_CANVAS: SpatialCanvas = { nodes: [], edges: [] }

/**
 * Rasterizes an already-serialized SVG through an <img> + <canvas> 2D context.
 * Returns null when no real 2D context exists (e.g. jsdom) — that is
 * "format unavailable in this environment", not an error.
 */
async function rasterizeSvgToPng(svg: string, width: number, height: number): Promise<Blob | null> {
  const canvasEl = document.createElement('canvas')
  canvasEl.width = width
  canvasEl.height = height
  const ctx = canvasEl.getContext('2d')
  if (!ctx) return null

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('failed to load rasterized SVG'))
      img.src = url
    })
    ctx.drawImage(image, 0, 0, width, height)
  } finally {
    URL.revokeObjectURL(url)
  }
  return new Promise<Blob | null>((resolve) => {
    canvasEl.toBlob(resolve, 'image/png')
  })
}

function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}

/**
 * useCanvasSync — canonical sync hook for both the browser-local backend and
 * a daemon-backed connection.
 *
 * This hook is React glue only: state, the connect/teardown effect, and the
 * keyboard undo-redo intercept. All per-connection state (the LoroDoc, its
 * UndoManager, the debounced commit pipeline, queued export requests, and
 * the CanvasBackendHandlers wiring) lives in a `CanvasSyncSession` from
 * `../lib/canvas-sync-session.js` — a plain non-React module constructed
 * fresh for every backend identity. This hook mirrors the session's
 * published canvas value into React state via `session.subscribe`, and
 * forwards `onChange(next, command)` — structurally the same signature as
 * `SpatialEditorProps['onChange']` — straight through to the session.
 *
 * Accepts a CanvasBackend (e.g. BrowserLocalBackend) or null when no backend
 * is available yet (e.g. the initial snapshot is still loading). A null
 * backend never connects: syncStatus stays 'idle', canvas stays the empty
 * canvas, and onChange is a no-op. When the backend identity changes —
 * including null-to-backend and backend-to-backend — the previous session
 * is fully disposed before the new one connects. This is the mechanism a
 * browser-local -> daemon in-place migration rides on: swapping the
 * CanvasBackend prop is the whole contract.
 *
 * `options` wires the daemon-only capability receptors (onVersionCreated,
 * onHeadChanged) plus the restore-overlay state and
 * onViewportRequest/onExportRequest/onAuthError handling that a daemon
 * backend can drive. A browser-local backend never fires any of these
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
export function useCanvasSync(
  backend: CanvasBackend | null,
  options?: UseCanvasSyncOptions,
): UseCanvasSyncResult {
  // Latest-prop mirrors deliberately excluded from the connect effect's
  // dependency array below: reading `backend`/`options` through these refs
  // (rather than as effect deps) means a fresh inline object passed on every
  // render never forces a reconnect.
  const backendRef = useRef<CanvasBackend | null>(backend)
  backendRef.current = backend
  const optionsRef = useRef<UseCanvasSyncOptions>(options ?? {})
  optionsRef.current = options ?? {}

  // Handle to the live extracted session (null when backend is null / no
  // session has been created yet).
  const sessionRef = useRef<CanvasSyncSession | null>(null)

  // Hook-owned (not session-owned) generation counters — see this hook's
  // doc comment and `createGenerationCounters` for why they must survive a
  // session swap within this hook instance rather than resetting per session.
  const generationsRef = useRef(createGenerationCounters())

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [canvas, setCanvas] = useState<SpatialCanvas>(EMPTY_CANVAS)
  const [loaded, setLoaded] = useState(false)
  const [externalVersion, setExternalVersion] = useState(0)
  // Render signal only — the value itself is never read.
  const [, setHistoryVersion] = useState(0)
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
    // The body belongs to the session being torn down, exactly as the locks
    // do — left standing it would render against whatever document is next.
    setMarkdownBodyState('')
    setCoreFacetsState(undefined)

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

    const session = createCanvasSyncSession(backend, {
      getOptions: () => optionsRef.current,
      onStatusChange: setSyncStatus,
      onRestoreChange: (inProgress, label) => {
        setRestoreInProgress(inProgress)
        setRestoreLabel(label)
      },
      dispatchIdentityEvent,
      generations: generationsRef.current,
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
    session.connect()
    session.onEditorReady()

    return () => {
      unsubscribe()
      unsubscribeHistory()
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
      const png = await rasterizeSvgToPng(
        svg,
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
    markdownBody,
    coreFacets,
    setCoreFacets,
    lockedEdgeIds,
    setEdgeLock,
    canRedo,
    exportScene,
  }
}
