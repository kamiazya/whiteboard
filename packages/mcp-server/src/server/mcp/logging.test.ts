import { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _destinationCountForTests,
  type CapturedLogsHandle,
  captureLogsForTests,
  getLogger,
} from '../log.js'
import { runWithRequestLog, wireMcpLogging } from './logging.js'

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.0' })
}

function sink() {
  return vi.fn((_level: string, _data: unknown, _logger?: string) => Promise.resolve())
}

describe('wireMcpLogging', () => {
  let cap: CapturedLogsHandle

  beforeEach(() => {
    cap = captureLogsForTests('debug')
    wireMcpLogging(makeServer())
  })

  afterEach(() => {
    cap.restore()
  })

  it('declares the logging capability so the SDK accepts logging/setLevel', () => {
    const server = makeServer()
    const spy = vi.spyOn(server.server, 'registerCapabilities')
    wireMcpLogging(server)
    expect(spy).toHaveBeenCalledWith({ logging: {} })
  })

  it("forwards a record emitted inside a request's scope to that request's sink", () => {
    const log = sink()
    runWithRequestLog(log, () => {
      getLogger('document-store').warning({ workspaceId: 'ws_1' }, 'skipped corrupt row')
    })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      'warning',
      { msg: 'skipped corrupt row', workspaceId: 'ws_1' },
      'document-store',
    )
  })

  it('forwards a record emitted outside every request scope to no sink', async () => {
    const log = sink()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // A request is in flight (its scope is live, awaiting) while unrelated
    // code logs from outside it.
    const inFlight = runWithRequestLog(log, () => held)
    getLogger('sync-sse').warning({ workspaceId: 'ws_other' }, 'refused')
    release()
    await inFlight
    expect(log).not.toHaveBeenCalled()
    expect(cap.records.map((r) => r.msg)).toContain('refused')
  })

  it('keeps two interleaved requests apart across awaits', async () => {
    const a = sink()
    const b = sink()
    let releaseB: () => void = () => {}
    const bReady = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    const callA = runWithRequestLog(a, async () => {
      await bReady
      getLogger('t').warning('from a')
    })
    const callB = runWithRequestLog(b, async () => {
      getLogger('t').warning('from b')
      releaseB()
      await callA
      getLogger('t').warning('from b again')
    })
    await Promise.all([callA, callB])
    expect(a.mock.calls.map((c) => (c[1] as { msg: string }).msg)).toEqual(['from a'])
    expect(b.mock.calls.map((c) => (c[1] as { msg: string }).msg)).toEqual([
      'from b',
      'from b again',
    ])
  })

  it('still records to the other destinations so logging keeps working', () => {
    runWithRequestLog(sink(), () => getLogger('app').error('boom'))
    expect(cap.records).toHaveLength(1)
    expect(cap.records[0]).toMatchObject({ level: 'error', scope: 'app', msg: 'boom' })
  })

  it('swallows a rejecting sink so logging never crashes the daemon', async () => {
    const log = vi.fn(() => Promise.reject(new Error('no peer')))
    expect(() => runWithRequestLog(log, () => getLogger('any').notice('peer-less'))).not.toThrow()
    // One microtask so an unhandled rejection would surface; vitest fails the
    // test on one.
    await Promise.resolve()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('adds no destination per server, so per-request servers cannot grow the set', () => {
    const baseline = _destinationCountForTests()
    for (let i = 0; i < 20; i++) wireMcpLogging(makeServer())
    expect(_destinationCountForTests()).toBe(baseline)
  })
})
