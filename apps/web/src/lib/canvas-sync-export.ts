import type { ExportRequestPayload } from '@kamiazya/whiteboard-mcp/browser-contract'

// Ported verbatim from the original daemon-served UI's useWhiteboardSync
// helpers (since retired; buildWhiteboardWsProtocols/buildWhiteboardWsUrl and
// applyRestoreComplete/RestoreCompleteDeps were intentionally excluded —
// daemon-only / trivially inlined at the call site instead).
//
// canvas-sync-session.ts wires `api: null` permanently (SpatialEditor has no
// Excalidraw-shaped imperative API), so `sendExportResponse` below is
// unreachable today and only the queueing path in
// handleIncomingExportRequest/flushPendingExportRequests ever runs.
//
// The element/files shapes are declared locally rather than imported from
// `@excalidraw/excalidraw`: only `id`/`type`/`fontSize`/`frameId` are read
// and `files` is passed through opaquely, so the structural declaration
// carries the whole contract without the dependency.
type ExportElement = {
  id: string
  type: string
  fontSize: number
  frameId?: string | null
}

type ExportFiles = Record<string, unknown>

type ExportApi = {
  getSceneElements: () => readonly ExportElement[]
  getAppState: () => Record<string, unknown>
  getFiles: () => ExportFiles
}

type ExportRequestPayloadNoType = Omit<ExportRequestPayload, 'type'>

export interface ExportRequestHandlerDeps {
  api: ExportApi | null
  pending: ExportRequestPayloadNoType[]
  send: (message: string) => void
  exportToBlobFn: (args: {
    elements: readonly ExportElement[]
    appState: Record<string, unknown>
    files: ExportFiles
    exportPadding: number
  }) => Promise<Blob>
  blobToBase64Fn: (blob: Blob) => Promise<string>
}

async function sendExportResponse(
  msg: ExportRequestPayloadNoType,
  api: ExportApi,
  deps: Omit<ExportRequestHandlerDeps, 'api' | 'pending'>,
): Promise<void> {
  const rawElements = api.getSceneElements()
  // If frameId is set, keep only that frame's children (el.frameId === target) and the frame itself.
  // A missing frameId resolves to an empty list.
  const frameId = msg.frameId
  const scoped: readonly ExportElement[] =
    frameId !== undefined
      ? rawElements.filter((el) => el.id === frameId || el.frameId === frameId)
      : rawElements
  const minFontPx = msg.minFontPx
  const elements: readonly ExportElement[] =
    minFontPx !== undefined
      ? scoped.map((el) => {
          if (el.type !== 'text' || el.fontSize >= minFontPx) {
            return el
          }
          return { ...el, fontSize: minFontPx }
        })
      : scoped
  const rawAppState = api.getAppState()
  // Mirror the headless renderer: when the export request forces a theme
  // we override appState.theme and viewBackgroundColor so the same canvas
  // renders consistently across the browser and headless paths.
  const themeOverride =
    msg.theme !== undefined
      ? {
          theme: msg.theme,
          viewBackgroundColor: msg.theme === 'dark' ? '#121212' : '#ffffff',
        }
      : null
  const appState = {
    ...rawAppState,
    exportEmbedScene: true,
    ...(msg.scale !== undefined ? { exportScale: msg.scale } : {}),
    ...(themeOverride ?? {}),
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
  msg: ExportRequestPayloadNoType,
  deps: ExportRequestHandlerDeps,
): Promise<'queued' | 'sent'> {
  if (!deps.api) {
    deps.pending.push(msg)
    return 'queued'
  }
  await sendExportResponse(msg, deps.api, deps)
  return 'sent'
}

export async function flushPendingExportRequests(deps: ExportRequestHandlerDeps): Promise<number> {
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
