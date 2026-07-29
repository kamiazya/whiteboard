import { type ClientTextMessage, clientTextMessageSchema } from '../../shared/ws-messages.js'
import { getLogger } from '../log.js'
import { ValidationError, validateSlug, validateWorkspaceId } from '../validators.js'

const log = getLogger('ws')

export function parseWsTargetFromRequestUrl(
  rawUrl: string | undefined,
  host = 'localhost',
): { workspaceId: string; slug: string } {
  const url = new URL(rawUrl ?? '/', `http://${host}`)
  const parts = url.pathname.split('/')
  if (parts.length !== 4 || parts[1] !== 'ws') {
    throw new ValidationError(
      'invalid_ws_path',
      `Invalid websocket path "${url.pathname}": expected /ws/:workspaceId/:slug`,
    )
  }

  const workspaceId = validateWorkspaceId(parts[2] ?? '')
  let slug = ''
  try {
    slug = decodeURIComponent(parts[3] ?? '')
  } catch {
    throw new ValidationError('invalid_slug', `Invalid slug in websocket path "${url.pathname}"`)
  }
  return { workspaceId, slug: validateSlug(slug) }
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
