/**
 * Minimal, dependency-free logging seam for this shared layer.
 *
 * server-core must run unchanged on Node, the browser, and Cloudflare
 * Workers, so it cannot reach for a Node-only backend (pino + node:stream,
 * as mcp-server's composition-root logger does) or a `console.*` call
 * (banned by repo-wide logging discipline). Instead this module exposes an
 * injectable sink: composition roots call `setLogSink` once at startup to
 * forward records into their real logger (or a test capture buffer); with
 * no sink configured, records are silently dropped rather than leaking to
 * a global console/stream this package has no business touching.
 *
 * Levels follow RFC 5424 naming to stay consistent with the rest of the
 * repo's logging (see mcp-server's `log.ts`), even though this seam does
 * not itself implement MCP `notifications/message` forwarding.
 */

type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency'

interface LogRecord {
  readonly scope: string
  readonly level: LogLevel
  readonly msg: string
  readonly data?: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

const LOG_LEVELS: readonly LogLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
]

let sink: LogSink = () => {}

/** Installs the sink every `getLogger` scope forwards records to. */
export function setLogSink(next: LogSink): void {
  sink = next
}

export type Logger = Readonly<
  Record<LogLevel, (msg: string, data?: Record<string, unknown>) => void>
>

/** Returns a scoped logger with one method per RFC 5424 level. */
export function getLogger(scope: string): Logger {
  const entries = LOG_LEVELS.map((level) => {
    const fn = (msg: string, data?: Record<string, unknown>): void => {
      sink({ scope, level, msg, data })
    }
    return [level, fn] as const
  })
  return Object.fromEntries(entries) as Logger
}
