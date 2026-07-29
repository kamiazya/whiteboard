import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CapturedLogsHandle, captureLogsForTests, getLogger } from '../log.js'
import { wireMcpLogging } from './logging.js'

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.0' })
}

describe('wireMcpLogging', () => {
  let cap: CapturedLogsHandle

  beforeEach(() => {
    // Capture mode opens an extra fanout subscriber on the project logger
    // so we can also assert "the previous destination still receives the
    // record" — the same role the explicit baseSink played before.
    cap = captureLogsForTests('debug')
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

  it('forwards every emitted record to server.sendLoggingMessage with the spec shape', () => {
    const server = makeServer()
    const sendSpy = vi
      .spyOn(server, 'sendLoggingMessage')
      .mockResolvedValue({} as Awaited<ReturnType<typeof server.sendLoggingMessage>>)
    wireMcpLogging(server)

    getLogger('canvas-store').warning({ workspaceId: 'ws_1' }, 'skipped corrupt row')

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({
      level: 'warning',
      logger: 'canvas-store',
      data: { msg: 'skipped corrupt row', workspaceId: 'ws_1' },
    })
  })

  it('still records to the existing destinations (capture / stderr) so logging keeps working', () => {
    const server = makeServer()
    vi.spyOn(server, 'sendLoggingMessage').mockResolvedValue(
      {} as Awaited<ReturnType<typeof server.sendLoggingMessage>>,
    )
    wireMcpLogging(server)

    getLogger('app').error('boom')

    expect(cap.records).toHaveLength(1)
    expect(cap.records[0]).toMatchObject({ level: 'error', scope: 'app', msg: 'boom' })
  })

  it('swallows sendLoggingMessage rejections so logging never crashes the daemon', async () => {
    const server = makeServer()
    vi.spyOn(server, 'sendLoggingMessage').mockRejectedValue(new Error('no peer'))
    wireMcpLogging(server)

    expect(() => getLogger('any').notice('peer-less')).not.toThrow()
    // Wait one microtask so the unhandled promise resolution surfaces if it
    // would have leaked — vitest fails the test on unhandled rejections.
    await Promise.resolve()
    expect(cap.records).toHaveLength(1)
  })

  it('restore() detaches the MCP destination so subsequent records skip sendLoggingMessage', () => {
    const server = makeServer()
    const sendSpy = vi
      .spyOn(server, 'sendLoggingMessage')
      .mockResolvedValue({} as Awaited<ReturnType<typeof server.sendLoggingMessage>>)
    const handle = wireMcpLogging(server)
    handle.restore()

    getLogger('after').info('post-restore')

    expect(cap.records).toHaveLength(1)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('does not leak destinations when the caller forgets to call restore() but the server closes', async () => {
    // The HTTP /mcp handler in app.ts closes the underlying transport in
    // its finally block. wireMcpLogging discards the handle inside
    // createMcpServer, so the destination has to come back
    // automatically when the server closes — otherwise every per-request
    // server permanently grows the destination set.
    const { _destinationCountForTests } = await import('../log.js')
    const baseline = _destinationCountForTests()

    for (let i = 0; i < 20; i++) {
      const server = makeServer()
      vi.spyOn(server, 'sendLoggingMessage').mockResolvedValue(
        {} as Awaited<ReturnType<typeof server.sendLoggingMessage>>,
      )
      // Match the createMcpServer wiring: chain restore() onto
      // the server's onclose so the caller does not have to remember.
      const handle = wireMcpLogging(server)
      const previousOnClose = server.server.onclose?.bind(server.server)
      server.server.onclose = () => {
        try {
          handle.restore()
        } finally {
          previousOnClose?.()
        }
      }
      // Mirror what the MCP SDK does internally when the connected
      // transport closes: invoke server.server.onclose. McpServer.close()
      // alone is a no-op when no transport was attached, so calling the
      // hook directly is the most faithful simulation here.
      server.server.onclose?.()
    }

    expect(_destinationCountForTests()).toBe(baseline)
  })
})
