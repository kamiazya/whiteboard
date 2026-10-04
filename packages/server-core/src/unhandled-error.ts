import type { Context, ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { errorBody } from './api-errors.js'

/**
 * What a throw no route anticipated is told to the log: the error itself and
 * the request it came from, never its message in the answer.
 */
export interface UnhandledRequestError {
  readonly err: unknown
  readonly method: string
  readonly path: string
  /** `database_busy` is contention to retry; anything else is a defect. */
  readonly busy: boolean
}

/**
 * A database that stayed locked past its retry budget, recognised by the code
 * it keeps rather than by its class: the class lives in a Node-only store,
 * and an unretried busy answer raised inside a transaction carries the same
 * code. SQLite reports extended codes as `SQLITE_BUSY_*`.
 */
function isDatabaseBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { code } = err as { code?: unknown }
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY')
}

/**
 * The one answer to an uncaught throw: JSON in the contract every other
 * refusal speaks, so a client that parses the body of whatever comes back
 * reads a refusal rather than failing on Hono's `text/plain` default, and a
 * `report` the composition root points at its logger — the default prints the
 * raw error with `console.error`, which a server must never do.
 *
 * The body carries no part of the error: its message can hold a path, a
 * statement or a secret, and it reaches the log through `report` alone.
 * A thrown `HTTPException` already carries the response it means to send.
 */
export function answerUnhandled(report: (error: UnhandledRequestError) => void): ErrorHandler {
  return (err: unknown, c: Context) => {
    if (err instanceof HTTPException) return err.getResponse()
    const busy = isDatabaseBusy(err)
    report({ err, method: c.req.method, path: c.req.path, busy })
    if (busy) {
      return c.json(errorBody('database_busy', 'The database is busy; retry shortly.'), 503, {
        'Retry-After': '1',
      })
    }
    return c.json(errorBody('internal_error', 'The server failed to handle this request.'), 500)
  }
}
