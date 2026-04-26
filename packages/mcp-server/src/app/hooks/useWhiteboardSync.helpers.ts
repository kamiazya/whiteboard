import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { buildWhiteboardWsProtocols } from '../../shared/ws-protocol.js'

export interface ExportRequestMessage {
  type: 'export_request'
  requestId: string
  padding?: number
  scale?: number
  minFontPx?: number
  // When set, export only elements inside the frame plus the frame itself.
  // This keeps section-level PNG exports small on large canvases.
  frameId?: string
}

type ExportApi = {
  getSceneElements: () => readonly ExcalidrawElement[]
  getAppState: () => Record<string, unknown>
  getFiles: () => BinaryFiles
}

export interface ExportRequestHandlerDeps {
  api: ExportApi | null
  pending: ExportRequestMessage[]
  send: (message: string) => void
  exportToBlobFn: (args: {
    elements: readonly ExcalidrawElement[]
    appState: Record<string, unknown>
    files: BinaryFiles
    exportPadding: number
  }) => Promise<Blob>
  blobToBase64Fn: (blob: Blob) => Promise<string>
}

export interface RestoreCompleteDeps {
  setRestoreInProgress: (value: boolean) => void
  setRestoreLabel: (value: string | null) => void
  clearLocalUndo: () => void
}

export { buildWhiteboardWsProtocols }

export function buildWhiteboardWsUrl(
  locationHref: string,
  workspaceId: string,
  slug: string,
): string {
  const url = new URL(locationHref)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/${workspaceId}/${encodeURIComponent(slug)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function applyRestoreComplete({
  setRestoreInProgress,
  setRestoreLabel,
  clearLocalUndo,
}: RestoreCompleteDeps): void {
  setRestoreInProgress(false)
  setRestoreLabel(null)
  clearLocalUndo()
}

async function sendExportResponse(
  msg: ExportRequestMessage,
  api: ExportApi,
  deps: Omit<ExportRequestHandlerDeps, 'api' | 'pending'>,
): Promise<void> {
  const rawElements = api.getSceneElements()
  // If frameId is set, keep only that frame's children (el.frameId === target) and the frame itself.
  // A missing frameId resolves to an empty list.
  const frameId = msg.frameId
  const scoped: readonly ExcalidrawElement[] =
    frameId !== undefined
      ? rawElements.filter((el) => el.id === frameId || el.frameId === frameId)
      : rawElements
  const minFontPx = msg.minFontPx
  const elements: readonly ExcalidrawElement[] =
    minFontPx !== undefined
      ? scoped.map((el) => {
          if (el.type !== 'text' || el.fontSize >= minFontPx) {
            return el
          }
          return { ...el, fontSize: minFontPx } as ExcalidrawElement
        })
      : scoped
  const rawAppState = api.getAppState()
  const appState = {
    ...rawAppState,
    exportEmbedScene: true,
    ...(msg.scale !== undefined ? { exportScale: msg.scale } : {}),
  }
  const blob = await deps.exportToBlobFn({
    elements,
    appState,
    files: api.getFiles(),
    exportPadding: msg.padding ?? 10,
  })
  const base64 = await deps.blobToBase64Fn(blob)
  deps.send(
    JSON.stringify({
      type: 'export_response',
      requestId: msg.requestId,
      data: base64,
    }),
  )
}

export async function handleIncomingExportRequest(
  msg: ExportRequestMessage,
  deps: ExportRequestHandlerDeps,
): Promise<'queued' | 'sent'> {
  if (!deps.api) {
    deps.pending.push(msg)
    return 'queued'
  }
  await sendExportResponse(msg, deps.api, deps)
  return 'sent'
}

export async function flushPendingExportRequests(
  deps: ExportRequestHandlerDeps,
): Promise<number> {
  if (!deps.api || deps.pending.length === 0) return 0
  const queued = deps.pending.splice(0, deps.pending.length)
  let sent = 0
  try {
    for (const msg of queued) {
      await sendExportResponse(msg, deps.api, deps)
      sent += 1
    }
    return sent
  } catch (err) {
    deps.pending.unshift(...queued.slice(sent))
    throw err
  }
}
