import { describe, expect, it } from 'vitest'
// Imported STATICALLY, though nothing here mocks it. As `await import()`
// inside the test body, the transform-and-load of the whole barrel graph was
// charged to the 10s per-test budget — ample on an idle machine and the first
// thing to blow once every project runs in parallel. The test's own work is
// three property reads; only the load was slow, so it belongs in the
// collection phase, which no per-test timeout bounds.
import * as barrel from './index.js'
import { roundtrip } from './roundtrip.test-helper.js'
import {
  daemonPingResponseSchema,
  type RuntimeVerifyResponse,
  runtimeStatusResponseSchema,
  runtimeVerifyResponseSchema,
} from './runtime.js'

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

describe('runtimeVerifyResponseSchema', () => {
  const valid: RuntimeVerifyResponse = {
    alg: 'Ed25519',
    publicKey: 'pk-abc',
    signature: 'sig-xyz',
  }

  it('parses a well-formed value', () => {
    expect(runtimeVerifyResponseSchema.parse(valid)).toEqual(valid)
  })

  it('roundtrips through the wire format', () => {
    expect(roundtrip(runtimeVerifyResponseSchema, valid)).toEqual(valid)
  })

  it('rejects an extra field (strict schema catches server drift)', () => {
    expect(runtimeVerifyResponseSchema.safeParse({ ...valid, extra: 'unexpected' }).success).toBe(
      false,
    )
  })

  it('rejects a missing signature', () => {
    const { signature: _omit, ...missing } = valid
    expect(runtimeVerifyResponseSchema.safeParse(missing).success).toBe(false)
  })

  it('rejects an alg other than Ed25519 (an algorithm change must not pass silently)', () => {
    expect(runtimeVerifyResponseSchema.safeParse({ ...valid, alg: 'ES256' }).success).toBe(false)
  })
})

// The barrel is a published npm subpath (0.0.x semver liability), so widening
// it is a deliberate decision — see index.ts's own comment. This guard makes
// the other deliberate decision executable too: runtimeVerifyRequestSchema's
// refine touches Buffer (Node-only) and must never reach a browser bundle
// through the barrel, only through its module path (routes/runtime.ts's
// import). The positive-control assertion (…DOES contain
// runtimeVerifyResponseSchema) keeps the negative assertion from passing
// vacuously if the barrel export is ever renamed away.
describe('api-contracts barrel excludes the Buffer-refining request schema', () => {
  it('exports runtimeVerifyResponseSchema but not runtimeVerifyRequestSchema', () => {
    const keys = Object.keys(barrel)
    expect(keys).toContain('runtimeVerifyResponseSchema')
    expect(keys).not.toContain('runtimeVerifyRequestSchema')
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
