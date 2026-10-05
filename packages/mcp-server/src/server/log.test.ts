import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CapturedLogsHandle,
  captureLogsForTests,
  getLogger,
  getLogLevel,
  parseLogLevel,
  setLogLevel,
  setStderrLogDestination,
} from './log.js'

describe('parseLogLevel', () => {
  it('accepts every RFC 5424 level the MCP logging spec defines', () => {
    for (const level of [
      'debug',
      'info',
      'notice',
      'warning',
      'error',
      'critical',
      'alert',
      'emergency',
    ] as const) {
      expect(parseLogLevel(level)).toBe(level)
    }
  })

  it('treats "warn" as an alias for "warning" so callers do not stumble on Node-style names', () => {
    expect(parseLogLevel('warn')).toBe('warning')
  })

  it('returns null for unrecognised input so callers can fall back to a default', () => {
    expect(parseLogLevel('verbose')).toBeNull()
    expect(parseLogLevel(undefined)).toBeNull()
    expect(parseLogLevel('')).toBeNull()
  })
})

describe('setLogLevel', () => {
  let cap: CapturedLogsHandle
  beforeEach(() => {
    cap = captureLogsForTests('warning')
  })
  afterEach(() => {
    cap.restore()
  })

  it('moves the threshold at runtime so MCP logging/setLevel can change it', () => {
    setLogLevel('debug')
    expect(getLogLevel()).toBe('debug')
    setLogLevel('error')
    expect(getLogLevel()).toBe('error')
  })
})

describe('getLogger (pino-backed)', () => {
  let cap: CapturedLogsHandle
  beforeEach(() => {
    cap = captureLogsForTests('debug')
  })
  afterEach(() => {
    cap.restore()
  })

  it('emits a structured record via captureLogsForTests with scope, level, msg, and bindings as data', () => {
    const log = getLogger('document-store')
    log.warning({ workspaceId: 'ws_1', path: 'a' }, 'skipped corrupt row')

    expect(cap.records).toHaveLength(1)
    const record = cap.records[0]
    expect(record.level).toBe('warning')
    expect(record.scope).toBe('document-store')
    expect(record.msg).toBe('skipped corrupt row')
    expect(record.data).toMatchObject({ workspaceId: 'ws_1', path: 'a' })
    expect(typeof record.time).toBe('string')
  })

  it('drops calls below the active threshold without filling the capture buffer', () => {
    setLogLevel('warning')
    const log = getLogger('app')
    log.debug('chatty')
    log.info('also chatty')
    log.warning('important')
    expect(cap.records).toHaveLength(1)
    expect(cap.records[0].level).toBe('warning')
  })

  it('serialises Error instances under known keys (err / error / cause) into a stable shape', () => {
    const log = getLogger('checkpoint')
    const err = new Error('boom')
    log.error({ err }, 'save failed')

    expect(cap.records).toHaveLength(1)
    expect(cap.records[0].data).toMatchObject({
      err: expect.objectContaining({ message: 'boom' }),
    })
  })
})

describe('redaction', () => {
  let cap: CapturedLogsHandle
  let writeSpy: ReturnType<typeof vi.spyOn> | null = null
  let restoreStderr: () => void = () => {}

  beforeEach(() => {
    cap = captureLogsForTests('debug')
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // The test setup turns stderr off; redaction is asserted on the line it gets.
    restoreStderr = setStderrLogDestination(true)
  })
  afterEach(() => {
    restoreStderr()
    restoreStderr = () => {}
    cap.restore()
    writeSpy?.mockRestore()
  })

  // Every field name below is a real secret/PII carrier found in this
  // codebase (bootstrap token, daemon bearer token, OAuth access
  // token, Authorization header, cookie) or a common credential name a
  // careless call site could introduce (password, secret, apiKey).
  const secretFields: Record<string, string> = {
    token: 'wb-secret-token',
    daemonToken: 'daemon-secret-token',
    bootstrapToken: 'bootstrap-secret-token',
    accessToken: 'oauth-secret-token',
    authorization: 'Bearer super-secret',
    cookie: 'session=super-secret',
    password: 'hunter2',
    secret: 'shh',
    apiKey: 'sk-secret',
  }

  it('redacts every known secret field at the top level, for both the stderr destination and the MCP-notification-style capture destination', () => {
    const log = getLogger('redact-test')
    log.warning(secretFields, 'wholesale object logged carelessly')

    // MCP-notification-style destination (captureLogsForTests parses the
    // same fanout line a wireMcpLogging subscriber would receive).
    const record = cap.records[0]
    for (const key of Object.keys(secretFields)) {
      expect(record.data?.[key]).toBe('[redacted]')
    }

    // stderr destination — assert on the raw NDJSON line, not the parsed
    // record, so redaction is proven before any consumer-side reshaping.
    // Assert the spy actually captured this log call first: an unasserted
    // `undefined` last call would make `String(undefined)` (i.e. the string
    // "undefined") vacuously pass every `not.toContain(secret)` check below.
    const lastCall = writeSpy!.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const line = String(lastCall?.[0])
    expect(line).toContain('wholesale object logged carelessly')
    for (const value of Object.values(secretFields)) {
      expect(line).not.toContain(value)
    }
  })

  it('redacts secret fields nested one level deep (e.g. a wholesale client/request object)', () => {
    const log = getLogger('redact-test')
    log.warning(
      { client: { baseUrl: 'http://127.0.0.1:3099', token: 'daemon-secret-token' } },
      'logged the whole daemon client by mistake',
    )

    const record = cap.records[0]
    expect((record.data?.client as Record<string, unknown>)?.token).toBe('[redacted]')
    // Non-sensitive sibling field must survive untouched.
    expect((record.data?.client as Record<string, unknown>)?.baseUrl).toBe('http://127.0.0.1:3099')

    // See the vacuous-pass note above: assert the call happened and carries
    // the expected message before asserting on its content.
    const lastCall = writeSpy!.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const line = String(lastCall?.[0])
    expect(line).toContain('logged the whole daemon client by mistake')
    expect(line).not.toContain('daemon-secret-token')
  })

  it('does not let a token nested inside a logged Error leak through the err/error/cause serializers', () => {
    const log = getLogger('redact-test')
    const err = new Error('daemon request failed') as Error & { token?: string }
    err.token = 'daemon-secret-token'
    log.error({ err }, 'daemon request failed')

    const record = cap.records[0]
    const serialisedErr = record.data?.err as Record<string, unknown>
    expect(serialisedErr.message).toBe('daemon request failed')
    expect(serialisedErr.token).toBe('[redacted]')

    const lastCall = writeSpy!.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const line = String(lastCall?.[0])
    expect(line).toContain('daemon request failed')
    expect(line).not.toContain('daemon-secret-token')
  })

  it('leaves ordinary diagnostic fields untouched so redaction does not silently eat normal logs', () => {
    const log = getLogger('redact-test')
    log.warning({ workspaceId: 'ws_1', path: 'a', durationMs: 12 }, 'normal diagnostic record')

    const record = cap.records[0]
    expect(record.data).toMatchObject({ workspaceId: 'ws_1', path: 'a', durationMs: 12 })
  })
})

describe('default destination', () => {
  let writeSpy: ReturnType<typeof vi.spyOn> | null = null
  let restoreStderr: () => void = () => {}

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    restoreStderr = setStderrLogDestination(true)
    setLogLevel('debug')
  })

  afterEach(() => {
    restoreStderr()
    restoreStderr = () => {}
    writeSpy?.mockRestore()
    setLogLevel(parseLogLevel(process.env.WHITEBOARD_LOG_LEVEL) ?? 'warning')
  })

  it('writes one JSON line per record to process.stderr (safe for stdio MCP)', () => {
    const log = getLogger('canvas')
    log.info({ path: 'a' }, 'hello')

    expect(writeSpy).toHaveBeenCalled()
    const written = String(writeSpy!.mock.calls[0][0])
    expect(written.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(written.trimEnd())
    expect(parsed).toMatchObject({
      level: 'info',
      scope: 'canvas',
      msg: 'hello',
      path: 'a',
    })
  })

  it('never touches process.stdout (would corrupt stdio JSON-RPC frames)', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      getLogger('any').error('boom')
      expect(stdoutSpy).not.toHaveBeenCalled()
    } finally {
      stdoutSpy.mockRestore()
    }
  })
})

describe('the stderr destination switch', () => {
  let writeSpy: ReturnType<typeof vi.spyOn> | null = null
  let cap: CapturedLogsHandle
  let restoreStderr: () => void = () => {}

  beforeEach(() => {
    cap = captureLogsForTests('debug')
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    restoreStderr()
    restoreStderr = () => {}
    cap.restore()
    writeSpy?.mockRestore()
  })

  // Proves `vitest.log-setup.ts` is wired into this project, not merely that
  // the switch works when a test flips it.
  it('starts off under the test setup, so a passing run prints no records', () => {
    getLogger('setup').error('a refusal the test exercised on purpose')

    expect(cap.records).toHaveLength(1)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('holds across a fresh copy of the logger, which a test gets after vi.resetModules()', async () => {
    restoreStderr = setStderrLogDestination(false)
    vi.resetModules()
    const fresh = await import('./log.js')
    fresh.getLogger('fresh-copy').error('logged through a re-evaluated module')

    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('switched off, a record still reaches every other destination but not stderr', () => {
    restoreStderr = setStderrLogDestination(false)
    getLogger('quiet').error({ path: 'a' }, 'negative path exercised on purpose')

    expect(cap.records.map((r) => r.msg)).toEqual(['negative path exercised on purpose'])
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('switched on, the record reaches stderr', () => {
    restoreStderr = setStderrLogDestination(true)
    getLogger('loud').error('written where an operator reads it')

    expect(cap.records).toHaveLength(1)
    const lines: string[] = writeSpy!.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(lines.some((l) => l.includes('written where an operator reads it'))).toBe(true)
  })

  it('restores the state it found, so one test cannot leave the next one muted or loud', () => {
    restoreStderr = setStderrLogDestination(true)
    const restoreOff = setStderrLogDestination(false)
    restoreOff()
    getLogger('restored').error('loud again after the restore')

    const lines: string[] = writeSpy!.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(lines.some((l) => l.includes('loud again after the restore'))).toBe(true)
  })
})

describe('parseLogLevel normalises the same way every reader does', () => {
  /**
   * The startup gate trims before validating. If this did not, a padded value
   * would pass the gate and then resolve to the default — measured:
   * `'INFO '` validated as `info` and resolved to `warning`, which is exactly
   * the silent drop the gate exists to prevent.
   */
  it('accepts a whitespace-padded level, so the gate and the logger agree', () => {
    expect(parseLogLevel('INFO ')).toBe('info')
    expect(parseLogLevel('  debug')).toBe('debug')
    expect(parseLogLevel(' warn ')).toBe('warning')
  })

  it('still rejects blank and unknown values', () => {
    expect(parseLogLevel('   ')).toBeNull()
    expect(parseLogLevel('verbose')).toBeNull()
  })
})
