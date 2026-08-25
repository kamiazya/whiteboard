import { type ClientTextMessage, clientTextMessageSchema } from '../../shared/ws-messages.js'
import { getLogger } from '../log.js'
import { ValidationError, validateDocumentPath, validateWorkspaceId } from '../validators.js'

const log = getLogger('ws')

export function parseWsTargetFromRequestUrl(
  rawUrl: string | undefined,
  host = 'localhost',
): { workspaceId: string; path: string; scope: 'document' | 'workspace' } {
  const url = new URL(rawUrl ?? '/', `http://${host}`)
  // `?scope=workspace` opts the socket into workspace-document granularity
  // (order 7): same path (which stays the auth target and the auto-version
  // target), different subscription. Anything else is the per-document
  // default so an older client's URL keeps meaning what it always did.
  const scope = url.searchParams.get('scope') === 'workspace' ? 'workspace' : 'document'
  const parts = url.pathname.split('/')
  // The tail is a document path, so anything from one segment up is valid —
  // /ws/:workspaceId/<path...>. Each segment decodes separately; the
  // separators are structure, not data.
  if (parts.length < 4 || parts[1] !== 'ws') {
    throw new ValidationError(
      'invalid_ws_path',
      `Invalid websocket path "${url.pathname}": expected /ws/:workspaceId/<document path>`,
    )
  }

  const workspaceId = validateWorkspaceId(parts[2] ?? '')
  let path = ''
  try {
    path = parts.slice(3).map(decodeURIComponent).join('/')
  } catch {
    throw new ValidationError(
      'invalid_document_path',
      `Invalid path in websocket path "${url.pathname}"`,
    )
  }
  return { workspaceId, path: validateDocumentPath(path), scope }
}

export function parseWsClientTextMessage(text: string): ClientTextMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    log.warning({ text }, 'ignored invalid client message: malformed JSON')
    return null
  }

  const result = clientTextMessageSchema.safeParse(raw)
  if (!result.success) {
    log.warning({ reason: result.error.issues[0]?.message, raw }, 'ignored invalid client message')
    return null
  }
  return result.data
}
