import {
  ValidationError,
  validateSessionId,
  validateSlug,
} from '../validators.js'

export type ClientReadyMessage = { type: 'client_ready' }
export type ExportResponseMessage = {
  type: 'export_response'
  requestId: string
  data: string
}
export type ViewportResponseMessage = {
  type: 'viewport_response'
  requestId: string
}
export type WsClientTextMessage =
  | ClientReadyMessage
  | ExportResponseMessage
  | ViewportResponseMessage

function warnInvalidWsMessage(reason: string, value: unknown): void {
  console.warn('[ws] ignored invalid client message:', reason, value)
}

export function parseWsTargetFromRequestUrl(
  rawUrl: string | undefined,
  host = 'localhost',
): { sessionId: string; slug: string } {
  const url = new URL(rawUrl ?? '/', `http://${host}`)
  const parts = url.pathname.split('/')
  if (parts.length !== 4 || parts[1] !== 'ws') {
    throw new ValidationError(
      'invalid_ws_path',
      `Invalid websocket path "${url.pathname}": expected /ws/:sessionId/:slug`,
    )
  }

  const sessionId = validateSessionId(parts[2] ?? '')
  let slug = ''
  try {
    slug = decodeURIComponent(parts[3] ?? '')
  } catch {
    throw new ValidationError('invalid_slug', `Invalid slug in websocket path "${url.pathname}"`)
  }
  return { sessionId, slug: validateSlug(slug) }
}

export function parseWsClientTextMessage(text: string): WsClientTextMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    warnInvalidWsMessage('malformed JSON', text)
    return null
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnInvalidWsMessage('message must be an object', raw)
    return null
  }

  const type = (raw as { type?: unknown }).type
  if (type === 'client_ready') {
    return { type }
  }
  if (type === 'export_response') {
    const requestId = (raw as { requestId?: unknown }).requestId
    const data = (raw as { data?: unknown }).data
    if (typeof requestId !== 'string' || typeof data !== 'string') {
      warnInvalidWsMessage('export_response requires requestId and data', raw)
      return null
    }
    return { type, requestId, data }
  }
  if (type === 'viewport_response') {
    const requestId = (raw as { requestId?: unknown }).requestId
    if (typeof requestId !== 'string') {
      warnInvalidWsMessage('viewport_response requires requestId', raw)
      return null
    }
    return { type, requestId }
  }

  warnInvalidWsMessage('unknown message type', raw)
  return null
}
