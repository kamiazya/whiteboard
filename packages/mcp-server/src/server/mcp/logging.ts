import type { McpServer } from '@modelcontextprotocol/server'

// Bridge our internal logger to the MCP `notifications/message` channel
// described in https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging.
//
// Wiring contract:
//   1. Declare the `logging: {}` capability so the SDK accepts
//      `logging/setLevel` and `notifications/message`.
//   2. Add a fanout destination on the project logger that forwards every
//      record to `server.sendLoggingMessage(...)`. The default stderr
//      destination stays in place so HTTP-only callers and stdio operators
//      still see records even with no MCP peer.
// The SDK applies its own per-session level filter on top of the project
// logger's threshold, so `logging/setLevel` from a client only changes
// what reaches that client.
import { addLogDestination, lineToLogRecord } from '../log.js'

export interface WireMcpLoggingHandle {
  // Detach the MCP destination. Tests use this between cases.
  restore(): void
}

export function wireMcpLogging(server: McpServer): WireMcpLoggingHandle {
  // Capability registration is idempotent in the SDK, so re-running this in
  // tests across the same server instance is safe.
  server.server.registerCapabilities({ logging: {} })

  const dispose = addLogDestination({
    stream: {
      write(line: string) {
        const record = lineToLogRecord(line)
        if (!record) return
        // Match the spec shape: level + optional logger + free-form data.
        // Keep msg inside `data` so structured consumers see the message
        // string alongside its fields.
        const params = {
          level: record.level,
          logger: record.scope,
          data:
            record.data !== undefined ? { msg: record.msg, ...record.data } : { msg: record.msg },
        }
        void server.sendLoggingMessage(params).catch(() => {
          // sendLoggingMessage rejects when the transport has no peer or
          // when the connection drops mid-flight. Logging itself must
          // never throw — stderr already captured the record from the
          // default destination.
        })
      },
    },
  })

  return {
    restore() {
      dispose()
    },
  }
}
