import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type CanvasSyncSession,
  createCanvasSyncSession,
  createGenerationCounters,
} from '../lib/canvas-sync-session.js'
import type { SyncStatus, UseCanvasSyncOptions } from '../lib/canvas-sync-types.js'
import { dispatchIdentityEvent } from '../lib/canvas-sync-types.js'
import { serializeSceneAsExcalidrawJson } from '@kamiazya/whiteboard-canvas-viewer/scene'

export type { SyncStatus, UseCanvasSyncOptions }
// Re-exported so existing call sites (e.g. DaemonCanvasPage) can keep
// importing these from the hook module; the canonical definitions live in
// lib/canvas-sync-types.ts alongside the session module that also needs them.
export { dispatchIdentityEvent }

// Raster/vector are the only formats the underlying @excalidraw/excalidraw
// export utilities support; there is no PDF export anywhere in the library.
export type SceneExportFormat = 'png' | 'svg' | 'json'

export interface UseCanvasSyncResult {
  syncStatus: SyncStatus
  setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => void
  onChange: (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => void
  restoreInProgress: boolean
  restoreLabel: string | null
  clearLocalUndo: () => void
  // null when no ExcalidrawImperativeAPI is registered yet (mount race) —
  // callers treat that the same as "export unavailable right now" rather
  // than throwing.
  exportScene: (format: SceneExportFormat) => Promise<Blob | null>
}

/**
 * useCanvasSync — canonical sync hook for both the browser-local backend and
 * (once slice 11 wires it up) a daemon-backed connection.
 *
 * This hook is React glue only: state, the connect/teardown effect, and the
 * keyboard/pointer undo-redo intercept. All per-connection state (the
 * LoroDoc, its UndoManager, the file cache, the debounced commit pipeline,
 * queued export requests, and the CanvasBackendHandlers wiring) lives in a
 * `CanvasSyncSession` from `../lib/canvas-sync-session.js` — a plain
 * non-React module constructed fresh for every backend identity.
 *
 * Accepts a CanvasBackend (e.g. BrowserLocalBackend) or null when no backend
 * is available yet (e.g. the initial snapshot is still loading). A null
 * backend never connects: syncStatus stays 'idle' and onChange is a no-op.
 * When the backend identity changes — including null-to-backend and
 * backend-to-backend — the previous session is fully disposed before the
 * new one connects. This is the mechanism a browser-local → daemon in-place
 * migration rides on: swapping the CanvasBackend prop is the whole contract.
 *
 * `options` wires the daemon-only capability receptors (onVersionCreated,
 * onHeadChanged, onFileUploadFailed/Succeeded) plus the restore-overlay
 * state and onViewportRequest/onExportRequest/onAuthError handling that a
 * daemon backend can drive. A browser-local backend never fires any of
 * these events, so passing no `options` behaves exactly as before this seam
 * was added.
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
  // Imperative handle set outside React's render cycle by Excalidraw's own
  // ref callback (via setExcalidrawAPI below), so it cannot be plain state
  // without forcing an extra render on every mount.
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)

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
  const [apiReady, setApiReady] = useState(false)
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

    if (backend === null) {
      sessionRef.current = null
      setSyncStatus('idle')
      // Bumps the connection generation even though no new session is
      // created, mirroring the pre-extraction hook's unconditional bump on
      // every effect run. Without this, a settling putFile() from the
      // just-disposed session would still match its own myGeneration (no
      // successor session ever advances the counter for a switch-to-null)
      // and would wrongly fire onFileUploadSucceeded/onFileUploadFailed for
      // a backend that is no longer attached.
      generationsRef.current.nextConnectionGeneration()
      return
    }

    const session = createCanvasSyncSession(backend, {
      getExcalidrawAPI: () => excalidrawAPIRef.current,
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
    session.connect()

    return () => {
      session.dispose()
    }
  }, [backend])

  // Reapply the current doc, re-send clientReady, and flush any export
  // request queued before the API existed, once the Excalidraw API becomes
  // ready. Fires independently of whether a snapshot has landed yet (session
  // methods no-op safely when there is no doc).
  useEffect(() => {
    if (!apiReady) return
    sessionRef.current?.onApiReady()
  }, [apiReady])

  const setExcalidrawAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawAPIRef.current = api
    setApiReady(true)
  }, [])

  const loroUndo = useCallback(() => {
    return sessionRef.current?.undo() ?? false
  }, [])

  const loroRedo = useCallback(() => {
    return sessionRef.current?.redo() ?? false
  }, [])

  const clearLocalUndo = useCallback(() => {
    sessionRef.current?.clearUndo()
  }, [])

  // Renders the live scene through the same exportToBlob/exportToSvg utilities
  // Excalidraw's own (harder-to-discover) hamburger-menu export dialog uses,
  // so a header-driven "Export" affordance produces byte-identical output
  // without duplicating export logic.
  const exportScene = useCallback(async (format: SceneExportFormat): Promise<Blob | null> => {
    const api = excalidrawAPIRef.current
    if (!api) return null
    const elements = api.getSceneElements()
    const appState = api.getAppState()
    const files = api.getFiles()
    if (format === 'png') {
      return exportToBlob({ elements, appState, files, exportPadding: 10 })
    }
    if (format === 'json') {
      // Produces the standard .excalidraw envelope ({type:'excalidraw',
      // version:2, ...}) matching the daemon's canvas_export_json, so the
      // file round-trips with Excalidraw desktop / excalidraw.com.
      const doc = serializeSceneAsExcalidrawJson(elements, appState, files)
      return new Blob([JSON.stringify(doc)], { type: 'application/json' })
    }
    const svg = await exportToSvg({ elements, appState, files, exportPadding: 10 })
    const serialized = new XMLSerializer().serializeToString(svg)
    return new Blob([serialized], { type: 'image/svg+xml' })
  }, [])

  // Keyboard and pointer intercept for undo/redo.
  useEffect(() => {
    function isEditingText(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return true
      if (target.isContentEditable) return true
      return false
    }

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

    function onPointerDown(ev: PointerEvent): void {
      if (!(ev.target instanceof Element)) return
      const btn = ev.target.closest('[data-testid="button-undo"], [data-testid="button-redo"]')
      if (!btn) return
      const testid = btn.getAttribute('data-testid')
      if (testid === 'button-undo') {
        if (loroUndo()) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      } else if (testid === 'button-redo') {
        if (loroRedo()) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions)
      window.removeEventListener('pointerdown', onPointerDown, {
        capture: true,
      } as EventListenerOptions)
    }
  }, [loroUndo, loroRedo])

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], _appState: AppState, files: BinaryFiles) => {
      sessionRef.current?.onChange(elements, files)
    },
    [],
  )

  return {
    syncStatus,
    setExcalidrawAPI,
    onChange,
    restoreInProgress,
    restoreLabel,
    clearLocalUndo,
    exportScene,
  }
}
