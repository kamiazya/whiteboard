import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureLogsForTests,
  getLogger,
  isLogLevelEnabled,
  parseLogLevel,
  setLogLevel,
  type CapturedLogsHandle,
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

describe('isLogLevelEnabled', () => {
  let cap: CapturedLogsHandle
  beforeEach(() => {
    cap = captureLogsForTests('warning')
  })
  afterEach(() => {
    cap.restore()
  })

  it('drops levels below the threshold and keeps the threshold and above', () => {
    expect(isLogLevelEnabled('debug')).toBe(false)
    expect(isLogLevelEnabled('info')).toBe(false)
    expect(isLogLevelEnabled('notice')).toBe(false)
    expect(isLogLevelEnabled('warning')).toBe(true)
    expect(isLogLevelEnabled('error')).toBe(true)
    expect(isLogLevelEnabled('emergency')).toBe(true)
  })

  it('reflects setLogLevel updates so MCP logging/setLevel can change the threshold at runtime', () => {
    setLogLevel('debug')
    expect(isLogLevelEnabled('debug')).toBe(true)
    setLogLevel('error')
    expect(isLogLevelEnabled('warning')).toBe(false)
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
    const log = getLogger('canvas-store')
    log.warning({ workspaceId: 'ws_1', slug: 'a' }, 'skipped corrupt row')

    expect(cap.records).toHaveLength(1)
    const record = cap.records[0]
    expect(record.level).toBe('warning')
    expect(record.scope).toBe('canvas-store')
    expect(record.msg).toBe('skipped corrupt row')
    expect(record.data).toMatchObject({ workspaceId: 'ws_1', slug: 'a' })
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

describe('default destination', () => {
  let writeSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setLogLevel('debug')
  })

  afterEach(() => {
    writeSpy?.mockRestore()
    setLogLevel(parseLogLevel(process.env.WHITEBOARD_LOG_LEVEL) ?? 'warning')
  })

  it('writes one JSON line per record to process.stderr (safe for stdio MCP)', () => {
    const log = getLogger('canvas')
    log.info({ slug: 'a' }, 'hello')

    expect(writeSpy).toHaveBeenCalled()
    const written = String(writeSpy!.mock.calls[0][0])
    expect(written.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(written.trimEnd())
    expect(parsed).toMatchObject({
      level: 'info',
      scope: 'canvas',
      msg: 'hello',
      slug: 'a',
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
