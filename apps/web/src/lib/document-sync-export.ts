import type { ExportRequestPayload } from '@kamiazya/whiteboard-mcp/browser-contract'

// The browser session has no imperative editor handle that could render an
// export, so an incoming export request can only be QUEUED — the daemon's
// export path renders headlessly on its own side, and nothing in the
// browser answers these. The queue records the requests so a future editor
// handle could serve them; until one exists there is deliberately no
// serving branch here.
type ExportRequestPayloadNoType = Omit<ExportRequestPayload, 'type'>

export interface ExportRequestHandlerDeps {
  pending: ExportRequestPayloadNoType[]
}

export function handleIncomingExportRequest(
  msg: ExportRequestPayloadNoType,
  deps: ExportRequestHandlerDeps,
): 'queued' {
  deps.pending.push(msg)
  return 'queued'
}
