import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { LoroDoc, LoroMap, UndoManager } from 'loro-crdt'
import type { Value } from 'loro-crdt'
import { restoreElements, CaptureUpdateAction } from '@excalidraw/excalidraw'
import { resolveParentedElements } from '@kamiazya/whiteboard-mcp/browser-shared'
import { validateLoroRawElements } from '@kamiazya/whiteboard-mcp/browser-shared'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import type {
  ExcalidrawImperativeAPI,
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from '@excalidraw/excalidraw/types'
import type { AppState } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'

export type SyncStatus = 'idle' | 'connected' | 'error'

export interface UseCanvasSyncResult {
  syncStatus: SyncStatus
  setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => void
  onChange: (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => void
}

// Small debounce helper with no external dependency.
function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      fn(...args)
      timer = null
    }, ms)
  }
  debounced.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return debounced as T & { cancel: () => void }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * useCanvasSync — browser-local port of useWhiteboardSync.
 *
 * Accepts a CanvasBackend (e.g. BrowserLocalBackend), drives a LoroDoc from
 * onSnapshot/onRemoteUpdate, hydrates Excalidraw via applyLoroToExcalidraw,
 * and writes scene changes back via a debounced onSceneChange → backend.pushLocalUpdate.
 *
 * Daemon-specific callbacks (onVersionCreated, onRestoreStarted, onRestoreComplete,
 * onHeadChanged, onViewportRequest, onExportRequest) are wired as no-ops to satisfy
 * the CanvasBackendHandlers interface without importing server-only helpers.
 *
 * applyGenerationRef is never reset to 0 — only ever incremented — to avoid
 * stale-async collisions when the hook is reused across canvas remounts.
 */
export function useCanvasSync(backend: CanvasBackend): UseCanvasSyncResult {
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const docRef = useRef<LoroDoc | null>(null)
  const undoManagerRef = useRef<UndoManager | null>(null)
  const filesCacheRef = useRef<Record<string, BinaryFileData>>({})
  const uploadedFileIdsRef = useRef<Set<string>>(new Set())
  const backendRef = useRef<CanvasBackend>(backend)
  backendRef.current = backend

  // Monotonic — never reset to 0 to prevent stale async work from a prior mount
  // landing in the current doc after a fast remount.
  const applyGenerationRef = useRef(0)

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [apiReady, setApiReady] = useState(false)

  async function applyLoroToExcalidraw(doc: LoroDoc) {
    const generation = ++applyGenerationRef.current

    const movable = doc.getMovableList('elements').toJSON()
    const chosenRaw: unknown[] = movable.length > 0 ? movable : doc.getList('elements').toJSON()

    const validated = validateLoroRawElements(chosenRaw)
    const elements = resolveParentedElements(validated) as unknown as ExcalidrawElement[]

    const missingIds = elements
      .filter(
        (el): el is ExcalidrawElement & { fileId: string } =>
          el.type === 'image' &&
          !!(el as { fileId?: string }).fileId &&
          !filesCacheRef.current[(el as { fileId?: string }).fileId!],
      )
      .map((el) => (el as { fileId: string }).fileId)

    const bk = backendRef.current
    await Promise.allSettled(
      missingIds.map(async (fileId) => {
        const blob = await bk.getFile(fileId)
        if (!blob) return
        const dataURL = await blobToBase64(blob)
        filesCacheRef.current[fileId] = {
          id: fileId as FileId,
          mimeType: blob.type as BinaryFileData['mimeType'],
          dataURL: dataURL as DataURL,
          created: Date.now(),
        }
      }),
    )

    if (generation !== applyGenerationRef.current) return

    const api = excalidrawAPIRef.current
    if (!api) return

    api.addFiles(Object.values(filesCacheRef.current))
    const restoredElements = restoreElements(elements, null, { repairBindings: true })
    api.updateScene({
      elements: restoredElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }

  // Backend connect/disconnect lifecycle.
  useEffect(() => {
    docRef.current = null
    undoManagerRef.current = null
    filesCacheRef.current = {}
    uploadedFileIdsRef.current = new Set()
    applyGenerationRef.current += 1

    const bk = backendRef.current

    bk.connect({
      onConnected() {
        setSyncStatus('connected')
      },

      onSnapshot(bytes) {
        const doc = LoroDoc.fromSnapshot(bytes)
        docRef.current = doc
        undoManagerRef.current = new UndoManager(doc, { mergeInterval: 500 })

        doc.subscribeLocalUpdates((update) => {
          backendRef.current.pushLocalUpdate(update)
        })

        doc.subscribe((e) => {
          if (e.by === 'import') {
            void applyLoroToExcalidraw(doc)
          }
        })

        void applyLoroToExcalidraw(doc)
      },

      onRemoteUpdate(bytes) {
        docRef.current?.import(bytes)
      },

      // Daemon-specific callbacks — no-ops in browser-local mode.
      onVersionCreated: () => {},
      onRestoreStarted: () => {},
      onRestoreComplete: () => {},
      onHeadChanged: () => {},
      onViewportRequest: () => {},
      onExportRequest: async () => {},

      onError: () => {
        setSyncStatus('error')
      },
    })

    return () => {
      bk.disconnect()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reapply the current document once the Excalidraw API becomes ready.
  useEffect(() => {
    if (!apiReady || !docRef.current) return
    void applyLoroToExcalidraw(docRef.current)
  }, [apiReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const setExcalidrawAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawAPIRef.current = api
    setApiReady(true)
  }, [])

  const loroUndo = useCallback(() => {
    const um = undoManagerRef.current
    const doc = docRef.current
    if (!um || !doc) return false
    if (!um.canUndo()) return false
    um.undo()
    void applyLoroToExcalidraw(doc)
    return true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loroRedo = useCallback(() => {
    const um = undoManagerRef.current
    const doc = docRef.current
    if (!um || !doc) return false
    if (!um.canRedo()) return false
    um.redo()
    void applyLoroToExcalidraw(doc)
    return true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Debounced scene change → commit to Loro → pushLocalUpdate via subscribeLocalUpdates.
  const onSceneChange = useMemo(() => {
    return debounce((elements: readonly ExcalidrawElement[], files: BinaryFiles) => {
      const doc = docRef.current
      if (!doc) return

      const newEntries = Object.entries(files).filter(
        ([fileId, fd]) => fd && !uploadedFileIdsRef.current.has(fileId),
      ) as [string, BinaryFileData][]

      const bk = backendRef.current

      if (newEntries.length > 0) {
        void bk.putFile(newEntries, (fileId) => uploadedFileIdsRef.current.add(fileId))
      }

      // Write elements into the Loro MovableList using field-by-field set operations,
      // then commit so subscribeLocalUpdates fires and routes bytes to backend.pushLocalUpdate.
      const list = doc.getMovableList('elements')
      const current = list.toJSON() as ExcalidrawElement[]
      const currentIds = new Set(current.map((e: ExcalidrawElement) => e.id))

      // Append newly added elements.
      for (const el of elements) {
        if (!currentIds.has(el.id)) {
          const map = list.insertContainer(list.length, new LoroMap())
          for (const [k, v] of Object.entries(el)) {
            if (v !== undefined) map.set(k, v as Value)
          }
        }
      }

      // Update or tombstone existing elements.
      const nextById = new Map(elements.map((e) => [e.id, e]))
      for (let i = 0; i < list.length; i++) {
        const item = list.get(i)
        if (!(item instanceof LoroMap)) continue
        const id = item.get('id') as string
        const next = nextById.get(id)
        if (!next) {
          item.set('isDeleted', true)
        } else {
          for (const [k, v] of Object.entries(next)) {
            if (v !== undefined) item.set(k, v as Value)
          }
        }
      }

      doc.commit()
    }, 300)
  }, [])

  // Cancel debounce on unmount to prevent post-unmount Loro writes.
  useEffect(() => {
    return () => {
      onSceneChange.cancel()
    }
  }, [onSceneChange])

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], _appState: AppState, files: BinaryFiles) => {
      onSceneChange(elements, files)
    },
    [onSceneChange],
  )

  return { syncStatus, setExcalidrawAPI, onChange }
}
