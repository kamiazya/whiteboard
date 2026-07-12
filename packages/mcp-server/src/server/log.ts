// Pino-backed structured logger.
//
// The public API is intentionally just pino's own — `getLogger(scope)`
// returns a `pino.Logger<LogLevel, true>` so call sites can use pino's
// native `(bindings, msg)` argument order and methods (`debug` / `info` /
// `notice` / `warning` / `error` / `critical` / `alert` / `emergency`).
//
// Why pino:
//   • Native NDJSON output, no console.* stray writes (stdio MCP keeps
//     stdout reserved for JSON-RPC; we always write to stderr).
//   • `child({ scope })` for per-module loggers without manual key spread.
//   • `@opentelemetry/instrumentation-pino` auto-injects trace_id /
//     span_id into every record so logs and spans correlate.
//   • RFC 5424 levels by name (matching the MCP `notifications/message`
//     spec) via pino's `customLevels` + `useOnlyCustomLevels`.
//
// Tap surface for MCP integration / tests:
//   • `addLogDestination({ stream, level })` adds a fanout subscriber and
//     returns a dispose handle. wireMcpLogging uses it to forward records
//     to `server.sendLoggingMessage`. Tests use `captureLogsForTests` for
//     a typed records buffer.

import pino, { type DestinationStream, type Logger as PinoLogger, stdSerializers } from 'pino'
import { Writable } from 'node:stream'

// RFC 5424 severities exposed through MCP `notifications/message`. Order
// matters: lower index = more verbose. Pino numeric values follow the
// same order with `× 10` spacing so future levels are easy to slot in.
export const LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  notice: 30,
  warning: 40,
  error: 50,
  critical: 60,
  alert: 70,
  emergency: 80,
}

// Stable record shape consumers (MCP bridge, tests) can rely on. Mirrors
// what pino emits, plus a normalised ISO time and a `data` bag for
// arbitrary structured fields.
export interface LogRecord {
  time: string
  level: LogLevel
  scope: string
  msg: string
  data?: Record<string, unknown>
}

export type Logger = PinoLogger<LogLevel, true>

const DEFAULT_LEVEL: LogLevel = 'warning'

export function parseLogLevel(input: string | undefined | null): LogLevel | null {
  if (typeof input !== 'string' || input.length === 0) return null
  const normalised = input.toLowerCase()
  // Tolerate "warn" — the Node ecosystem says warn, MCP says warning. Pino
  // itself does not accept "warn" once useOnlyCustomLevels is on, so we
  // collapse it here.
  if (normalised === 'warn') return 'warning'
  return (LOG_LEVELS as readonly string[]).includes(normalised) ? (normalised as LogLevel) : null
}

function resolveInitialLevel(): LogLevel {
  return parseLogLevel(process.env.WHITEBOARD_LOG_LEVEL) ?? DEFAULT_LEVEL
}

// ── Fanout destination ────────────────────────────────────────────────
//
// pino was built for a single destination, so we put a tiny fanout stream
// in front of it. Each subscriber sees every NDJSON line at-or-above its
// own threshold; subscribers come and go via addLogDestination.

interface ManagedDestination {
  levelValue: number
  stream: DestinationStream
}

const destinations = new Set<ManagedDestination>()

const fanout = new Writable({
  write(chunk, _encoding, callback) {
    const line = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8')
    // Pull the level field once so each destination's threshold check is O(1).
    let lineLevel = LEVEL_VALUES[DEFAULT_LEVEL]
    const levelMatch = line.match(/"level":"([a-z]+)"/)
    if (levelMatch) {
      const v = LEVEL_VALUES[levelMatch[1] as LogLevel]
      if (typeof v === 'number') lineLevel = v
    }
    for (const dest of destinations) {
      if (lineLevel < dest.levelValue) continue
      try {
        dest.stream.write(line)
      } catch {
        // Logging itself must never throw. A misbehaving subscriber
        // dropping records is preferable to taking the daemon down.
      }
    }
    callback()
  },
})

// Stderr destination is added by default so a freshly imported logger
// already produces visible output (matches the previous behaviour).
const stderrDestination: ManagedDestination = {
  levelValue: LEVEL_VALUES.debug,
  stream: {
    write(line: string) {
      process.stderr.write(line)
    },
  },
}
destinations.add(stderrDestination)

// ── Root pino instance ────────────────────────────────────────────────

// Every path below is a real secret/PII carrier found in this codebase, or
// a common credential name a careless call site could introduce later:
//   - token / daemonToken / bootstrapToken: the local-daemon bearer token
//     (see shared/token-store.ts, mcp/tools/pairing-link.ts) — a `#wb=`
//     pairing URL or an Authorization header round-trips this value, and it
//     grants full daemon access to whoever holds it.
//   - accessToken: OAuth access tokens (security/oauth-resource-strategy.ts).
//   - authorization / cookie: raw auth headers a route handler might log
//     wholesale while debugging (`c.req.header('authorization')`).
//   - password / secret / apiKey: not currently produced by this codebase,
//     kept as a generic net for future call sites.
// `*.<name>` covers one level of nesting (e.g. `{ client: { token } }`,
// `{ err: { token } }` after the error serializer runs) — fast-redact does
// not support an arbitrary-depth wildcard, so a secret nested two or more
// levels deep under a non-listed key would NOT be caught. Adding a new
// secret-bearing field anywhere in the server means adding both its
// top-level and its `*.<name>` path here.
//
// Capped at one level deliberately, not by oversight: every `log.*` call
// site in this server (grep `src/server/**/*.ts` for `log\.(debug|info|
// notice|warning|error|critical|alert|emergency)\(`) passes either a flat
// field bag or an `{ err }`/`{ error }`/`{ cause }` object, and the error
// serializer's own output is flat too — so today's deepest real secret
// position is exactly one level (`err.token`, `client.token`). A third
// tier (`*.*.<name>`) would double this list for a shape (`req.headers.
// authorization`, `config.auth.token`) nothing here currently produces.
// If a call site starts logging a wholesale two-level-nested object with a
// credential in it, add the `*.*.<name>` tier for that field then — don't
// pre-pay the per-path fast-redact cost for a shape that doesn't exist yet.
const REDACTED_PATHS = [
  'token',
  'daemonToken',
  'bootstrapToken',
  'accessToken',
  'authorization',
  'cookie',
  'password',
  'secret',
  'apiKey',
  '*.token',
  '*.daemonToken',
  '*.bootstrapToken',
  '*.accessToken',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.secret',
  '*.apiKey',
]

const root: Logger = pino(
  {
    level: resolveInitialLevel(),
    customLevels: LEVEL_VALUES,
    useOnlyCustomLevels: true as const,
    formatters: {
      // Emit the level *name* rather than the numeric value so the JSON
      // line and the MCP record share the same vocabulary.
      level(label) {
        return { level: label }
      },
    },
    // Strip pid/hostname noise — useful in collector pipelines but adds
    // weight to every record and is irrelevant to MCP consumers.
    base: null,
    // Serialise common error keys so callers can pass `{err}` / `{error}`
    // / `{cause}` and get `{name, message, stack}` automatically. Redaction
    // (below) runs on the fully serialised object, so a secret attached as
    // a custom property on an Error (`err.token = ...`) is still caught by
    // the `*.token` path even though it only exists after this serializer runs.
    serializers: {
      err: stdSerializers.err,
      error: stdSerializers.err,
      cause: stdSerializers.err,
    },
    // Censor rather than remove: these fields are diagnostically useful as
    // "a token/cookie was present" without exposing the value itself, and
    // `remove: true` would make an otherwise-valid record silently lose a
    // key, which is harder to notice than a censored placeholder.
    redact: {
      paths: REDACTED_PATHS,
      censor: '[redacted]',
    },
  },
  fanout,
)

export function getLogger(scope: string): Logger {
  // pino's child() typing widens the level generic to `boolean`; cast
  // back so call sites see the narrowed `Logger` type with our custom
  // method names (`notice`, `warning`, …) rather than the default ones.
  return root.child({ scope }) as Logger
}

export function setLogLevel(level: LogLevel): void {
  root.level = level
}

export function getLogLevel(): LogLevel {
  return root.level as LogLevel
}

export function isLogLevelEnabled(level: LogLevel): boolean {
  return LEVEL_VALUES[level] >= LEVEL_VALUES[root.level as LogLevel]
}

// ── Destination management ────────────────────────────────────────────

export interface LogDestinationOptions {
  // Stream-shaped sink. Anything with `write(line: string)` works —
  // process.stderr, a memory buffer, a pino-syslog instance, etc.
  stream: DestinationStream
  // Per-destination minimum level. Defaults to the verbose floor so all
  // records that pass the root level filter reach this destination.
  level?: LogLevel
}

export function addLogDestination(options: LogDestinationOptions): () => void {
  const dest: ManagedDestination = {
    stream: options.stream,
    levelValue: LEVEL_VALUES[options.level ?? 'debug'],
  }
  destinations.add(dest)
  return () => {
    destinations.delete(dest)
  }
}

// ── Test helpers ──────────────────────────────────────────────────────

export interface CapturedLogsHandle {
  records: LogRecord[]
  // Restore the previous level + remove the capture destination. Always
  // call from a `try/finally` (or `afterEach`) so other tests are not
  // poisoned by the elevated level.
  restore(): void
}

// Open a temporary destination that buffers parsed records. Sets the root
// level to `level` for the duration so the capture sees verbose lines.
export function captureLogsForTests(level: LogLevel = 'debug'): CapturedLogsHandle {
  const previousLevel = getLogLevel()
  setLogLevel(level)
  const records: LogRecord[] = []
  const dispose = addLogDestination({
    level,
    stream: {
      write(line: string) {
        try {
          records.push(parseRecord(JSON.parse(line)))
        } catch {
          // Skip malformed lines — capture is best-effort.
        }
      },
    },
  })
  return {
    records,
    restore() {
      dispose()
      setLogLevel(previousLevel)
    },
  }
}

function parseRecord(parsed: unknown): LogRecord {
  const obj = (parsed ?? {}) as Record<string, unknown>
  const { level, scope, msg, time, ...rest } = obj
  return {
    time:
      typeof time === 'number'
        ? new Date(time).toISOString()
        : typeof time === 'string'
          ? time
          : new Date().toISOString(),
    level: (typeof level === 'string' ? level : DEFAULT_LEVEL) as LogLevel,
    scope: typeof scope === 'string' ? scope : '',
    msg: typeof msg === 'string' ? msg : '',
    data: Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : undefined,
  }
}

// Re-exported helper for consumers (e.g. wireMcpLogging) that want to
// shape a parsed JSON line back into our LogRecord contract.
export const lineToLogRecord = (line: string): LogRecord | null => {
  try {
    return parseRecord(JSON.parse(line))
  } catch {
    return null
  }
}

// Test-only introspection: number of currently-registered destinations,
// including the default stderr one. Used by tests that guard against
// destination leaks (e.g. per-request MCP servers wiring + restoring).
export function _destinationCountForTests(): number {
  return destinations.size
}
