/**
 * What server mode keeps out of an answer that the local daemon gives its
 * owner. On the local daemon the caller IS the operator, so a corrupt file
 * is reported with the path to go inspect. On server mode the caller is a
 * member, and the absolute storage path, raw filesystem, SQL or engine text
 * tell them how this host is laid out and nothing they can act on. The
 * detail goes to the operator's log instead.
 */

import { describeThrown } from '@kamiazya/whiteboard-model'
import type { MiddlewareHandler } from 'hono'
import { getLogger } from '../log.js'

const log = getLogger('server-mode')

/**
 * The refusals whose message quotes what a dependency threw, answered with a
 * fixed one instead. A stored document OKF cannot spell is refused with the
 * serializer's own text; the caller can still act on the fixed message,
 * since it names the repair.
 */
const PUBLIC_MESSAGES: ReadonlyMap<string, { status: number; message: string }> = new Map([
  [
    'corrupt_stored_data',
    {
      status: 500,
      message: 'Stored data this request needed is corrupt. The server log names it.',
    },
  ],
  [
    'stored_document_unsupported_version',
    {
      status: 500,
      message:
        'This document was stored in a format newer than this server can read. ' +
        'The server log names it.',
    },
  ],
  [
    'document_serialize_failed',
    {
      status: 409,
      message:
        'This document holds a value its format cannot spell, so it cannot be read in it. ' +
        "Rewrite it with `wb_workspace_edit`'s `document.set` op to repair it. " +
        'The server log has the detail.',
    },
  ],
])

const INTERNAL_TOOL_ERROR_TEXT =
  'internal_error: the server failed to handle this call. The server log has the detail.'

/**
 * Rewrites every answer `PUBLIC_MESSAGES` names to its fixed message. One
 * response-side seam rather than a flag threaded through each router, so a
 * route added later that answers one of the codes is covered without
 * knowing about this.
 */
export function createServerModeStoredDataRedaction(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (c.res.status !== 409 && c.res.status !== 500) return
    if (!c.res.headers.get('content-type')?.includes('application/json')) return
    const body: unknown = await c.res
      .clone()
      .json()
      .catch(() => null)
    const error = (body as { error?: unknown } | null)?.error
    const fixed = typeof error === 'string' ? PUBLIC_MESSAGES.get(error) : undefined
    if (fixed === undefined || fixed.status !== c.res.status) return
    log.error(
      {
        method: c.req.method,
        path: c.req.path,
        error,
        detail: (body as { message?: unknown }).message,
      },
      'refusal detail withheld from the caller',
    )
    c.res = c.json({ error, message: fixed.message }, fixed.status as 409 | 500)
  }
}

/**
 * Faults rather than refusals: the keeper's storage, the database, or the
 * runtime itself failed, and the message carries their internals. A plain
 * `Error` is here too, because an unnamed error is whatever a dependency
 * threw — a refusal a caller should read is a named class.
 */
const FAULT_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'RuntimeError',
  'CompileError',
  'LinkError',
  'CorruptStoredDataError',
  'IncompatibleDatabaseError',
  'StoredDocumentUnreadableError',
  'SnapshotReassemblyError',
  'SqliteError',
  'LibsqlError',
])

function isRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (FAULT_NAMES.has(err.name)) return false
  // A Node system error, whatever it has been renamed to.
  if ('syscall' in err || 'errno' in err) return false
  // A wrapper that quotes its cause is only as safe as the cause it quotes.
  const { cause } = err
  if (cause instanceof Error && err.message.includes(cause.message.replace(/\.$/, ''))) {
    return isRefusal(cause)
  }
  return true
}

/**
 * The text a server-mode tool call answers an error with: a named domain
 * refusal verbatim, anything else a fixed internal-error text with the detail
 * logged.
 */
export function serverModeToolErrorText(tool: string, err: unknown): string {
  if (isRefusal(err)) return describeThrown(err)
  log.error({ tool, err }, 'tool call failed')
  return INTERNAL_TOOL_ERROR_TEXT
}
