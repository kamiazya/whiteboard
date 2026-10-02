import { setLogSink as setServerCoreLogSink } from '@kamiazya/whiteboard-server-core'
import { getLogger } from './log.js'

/**
 * Forwards server-core's records into this root's pino logger.
 *
 * server-core is a shared layer and cannot depend on a Node logger, so it
 * exposes an injectable sink and drops every record until a composition root
 * installs one — its fail-open warnings (a corrupt row skipped, a best-effort
 * step that failed) are invisible to an operator otherwise, though the path
 * itself never throws. Each root therefore arms it explicitly at startup:
 * `createApp` for both HTTP roots, and the stdio entry for itself.
 * `composition-roots.guard.test.ts` names a root that does not.
 *
 * Levels are named identically (RFC 5424) on both sides, so this is a straight
 * pass-through rather than a mapping. This package's logger takes the
 * structured payload before the message (pino's own convention), the reverse
 * of server-core's `(msg, data)`. Installing it again replaces the sink with an
 * equivalent one.
 */
export function routeServerCoreLogs(): void {
  setServerCoreLogSink((record) => {
    const log = getLogger(record.scope)
    if (record.data) {
      log[record.level](record.data, record.msg)
    } else {
      log[record.level](record.msg)
    }
  })
}
