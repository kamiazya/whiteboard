import { AsyncLocalStorage } from 'node:async_hooks'
import type { LoggingLevel, McpServer } from '@modelcontextprotocol/server'

// Bridge our internal logger to the MCP `notifications/message` channel
// described in https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging.
//
// A record is forwarded only to the request that PRODUCED it. The tool wrapper
// (tool-support.ts) runs each handler inside `runWithRequestLog`, carrying that
// call's `ctx.mcpReq.log`; the one destination below forwards a record only
// when it was emitted inside such a scope, and only to that scope's sink.
// A record emitted anywhere else — a background worker, another user's route,
// a sync stream, or a timer the call armed that fires after it has answered —
// reaches stderr and no MCP client. A process-wide fan-out to
// every connected server would hand one caller's records (workspace ids,
// sign-in failures) to whoever else had a request open.
//
// What reaches a client therefore follows the SDK's own per-request rules:
//   - stdio: one server per connection, so the request's notification goes
//     out on the one pipe and a 2025-era `logging/setLevel` holds for the
//     connection. Records outside a tool call, or logged after it has
//     answered, are stderr-only here too.
//   - HTTP `/mcp`, modern era (2026-07-28): delivered on the call's own
//     response stream when the request opts in with `_meta`
//     `io.modelcontextprotocol/logLevel` (the threshold); `logging/setLevel`
//     does not exist in that era.
//   - HTTP `/mcp`, 2025 era: the endpoint answers in JSON mode, which has no
//     stream to carry a request's notifications, so nothing is delivered;
//     `logging/setLevel` is accepted and binds a per-request server that is
//     discarded with the request.
//   - HTTP `/mcp` on server mode: nothing, in either era. The tool wrapper
//     opens no scope for a member's call (`callerReadsServerLog`), since a
//     record can carry a raw error or another user's ids.
// The project logger's own threshold (`WHITEBOARD_LOG_LEVEL`) applies first:
// a record below it is never produced, whatever a client asks for.
import { addLogDestination, lineToLogRecord } from '../log.js'

type RequestLog = (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>

// The store outlives its call: a timer or promise continuation armed inside
// the handler inherits it and may log long after the call has answered.
// `open` is what bounds a request's sink to the request itself.
interface RequestScope {
  readonly log: RequestLog
  open: boolean
}

const requestLog = new AsyncLocalStorage<RequestScope>()

// pino writes each line to the fan-out synchronously from the log call, so
// the store read here is the emitting call's own scope.
let destinationInstalled = false
function installForwardingDestination(): void {
  if (destinationInstalled) return
  destinationInstalled = true
  addLogDestination({
    stream: {
      write(line: string) {
        const scope = requestLog.getStore()
        if (!scope?.open) return
        const record = lineToLogRecord(line)
        if (!record) return
        // Keep msg inside `data` so structured consumers see the message
        // string alongside its fields.
        const data =
          record.data !== undefined ? { msg: record.msg, ...record.data } : { msg: record.msg }
        void scope.log(record.level, data, record.scope).catch(() => {
          // A dropped connection rejects the send. Logging itself must never
          // throw — stderr already holds the record.
        })
      },
    },
  })
}

/**
 * Runs `fn` with records it emits forwarded to `log` — one request's sink —
 * until `fn` has settled. Work it leaves behind (a debounce, a timer) logs to
 * stderr only, like any other code outside a request.
 */
export function runWithRequestLog<T>(log: RequestLog | undefined, fn: () => T): T {
  if (log === undefined) return fn()
  const scope: RequestScope = { log, open: true }
  const close = (): void => {
    scope.open = false
  }
  let result: T
  try {
    result = requestLog.run(scope, fn)
  } catch (err) {
    close()
    throw err
  }
  if (result instanceof Promise) return result.finally(close) as T
  close()
  return result
}

/**
 * Declares the `logging: {}` capability (so the SDK accepts
 * `logging/setLevel` from a 2025-era client and filters `ctx.mcpReq.log` by
 * it) and ensures the request-scoped forwarding destination exists.
 */
export function wireMcpLogging(server: McpServer): void {
  server.server.registerCapabilities({ logging: {} })
  installForwardingDestination()
}
