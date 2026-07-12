import { describe, expect, it } from 'vitest'
import { daemonPingResponseSchema, runtimeStatusResponseSchema } from './runtime.js'

function baseStatus(app: { served: boolean; buildPresent: boolean; ui: string }) {
  return {
    ok: true,
    pid: 1,
    host: '127.0.0.1',
    port: 3099,
    baseUrl: 'http://127.0.0.1:3099',
    version: '0.0.1',
    startedAt: '2026-01-01T00:00:00.000Z',
    uptimeMs: 0,
    idleForMs: 0,
    auth: { mode: 'local-token', hasToken: true },
    storage: { dataDir: '/tmp/whiteboard', dataDirWritable: true },
    app,
    mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
    clients: { connected: 0, ready: 0 },
  }
}

// pid was replaced with instanceId (a per-start crypto.randomUUID) so a stale
// pid can never be reused to misidentify a different process across a
// PID-reuse race. Any parser code still expecting pid must break loudly here
// rather than silently reading undefined.

describe('daemonPingResponseSchema', () => {
  it('accepts an instanceId (uuid string) response and rejects pid', () => {
    const parsed = daemonPingResponseSchema.parse({
      ok: true,
      instanceId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    })
    expect(parsed).toEqual({ ok: true, instanceId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  })

  it('rejects a legacy pid-shaped payload with no instanceId', () => {
    expect(() => daemonPingResponseSchema.parse({ ok: true, pid: 123 })).toThrow()
  })
})

// R5 of the MCP-UI retirement (ADR 0001) deletes the original daemon-served
// browser UI. 'legacy' is no longer a valid app.ui value; server-mode now
// reports the honest 'server-placeholder' value instead.
describe('runtimeStatusResponseSchema app.ui enum (R5 legacy retirement)', () => {
  it('accepts ui: "web-app"', () => {
    expect(() =>
      runtimeStatusResponseSchema.parse(
        baseStatus({ served: true, buildPresent: true, ui: 'web-app' }),
      ),
    ).not.toThrow()
  })

  it('accepts ui: "server-placeholder"', () => {
    expect(() =>
      runtimeStatusResponseSchema.parse(
        baseStatus({ served: true, buildPresent: true, ui: 'server-placeholder' }),
      ),
    ).not.toThrow()
  })

  it('rejects the retired ui: "legacy" value', () => {
    expect(() =>
      runtimeStatusResponseSchema.parse(
        baseStatus({ served: true, buildPresent: false, ui: 'legacy' }),
      ),
    ).toThrow()
  })
})
