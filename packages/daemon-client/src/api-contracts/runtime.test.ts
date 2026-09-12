import { describe, expect, it } from 'vitest'
import { didKeyToEd25519PublicKey } from './did-key.js'
// Imported STATICALLY, though nothing here mocks it. As `await import()`
// inside the test body, the transform-and-load of the whole barrel graph was
// charged to the 10s per-test budget — ample on an idle machine and the first
// thing to blow once every project runs in parallel. The test's own work is
// three property reads; only the load was slow, so it belongs in the
// collection phase, which no per-test timeout bounds.
import * as barrel from './index.js'
import { roundtrip } from './roundtrip.test-helper.js'
import {
  daemonIdentitySchema,
  daemonPingResponseSchema,
  type RuntimeVerifyResponse,
  runtimeStatusResponseSchema,
  runtimeVerifyRequestSchema,
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

// A real published Ed25519 did:key and the base64url key it decodes to, so
// the pair below is a fact about the method rather than this codec's output.
const REAL_DID = 'did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP'
const REAL_KEY = didKeyToEd25519PublicKey(REAL_DID) as string
const OTHER_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'

describe('daemonIdentitySchema binds the did to the key it names', () => {
  it('accepts an identity whose did decodes to its own publicKey', () => {
    const parsed = daemonIdentitySchema.parse({
      alg: 'Ed25519',
      publicKey: REAL_KEY,
      did: REAL_DID,
    })
    expect(parsed.did).toBe(REAL_DID)
  })

  // Wire-compat: a daemon predating the did advertises the key alone, and
  // that has to keep parsing.
  it('accepts an identity with no did at all', () => {
    expect(daemonIdentitySchema.parse({ alg: 'Ed25519', publicKey: REAL_KEY }).did).toBeUndefined()
  })

  // The one that matters. Both fields claim to name the same key, and until
  // the schema checked it a responder could advertise the pinned publicKey
  // beside a did naming a DIFFERENT key — so a verifier that imported from
  // the did would check signatures against the responder's own key while
  // believing it had the pinned one.
  it('refuses a did that names a different key than publicKey', () => {
    expect(
      daemonIdentitySchema.safeParse({ alg: 'Ed25519', publicKey: REAL_KEY, did: OTHER_DID })
        .success,
    ).toBe(false)
  })

  it.each([
    ['a did:key that is not base58btc', 'did:key:z6Mkhax0OIl'],
    [
      'a did:key carrying another multicodec',
      'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc',
    ],
    ['a prefix with nothing after it', 'did:key:'],
  ])('refuses %s', (_label, did) => {
    expect(
      daemonIdentitySchema.safeParse({ alg: 'Ed25519', publicKey: REAL_KEY, did }).success,
    ).toBe(false)
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
// it is a deliberate decision — see index.ts's own comment. The request
// schema stays off it because only the daemon parses verify REQUESTS; a
// browser needs the response schema alone. (Historically this was also a
// Buffer fence — the refine used Buffer.from and would have thrown in a
// browser — but the length check is text-arithmetic now, so the exclusion
// is purely a surface decision.) The positive-control assertion (…DOES
// contain runtimeVerifyResponseSchema) keeps the negative assertion from
// passing vacuously if the barrel export is ever renamed away.
describe('api-contracts barrel excludes the daemon-only request schema', () => {
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

describe('runtimeVerifyRequestSchema nonce length', () => {
  // The bound is computed from the base64url TEXT (no Buffer/atob), so the
  // schema parses identically in the browser and the daemon. Unpadded
  // base64url: 22 chars -> 16 bytes, 43 -> 32, 20 -> 15, 44 -> 33; a
  // length % 4 === 1 string is never valid base64url at all.
  it.each([
    [22, true],
    [43, true],
    [20, false],
    [44, false],
    [21, false],
  ])('a %i-char nonce is accepted=%s', (chars, ok) => {
    const parsed = runtimeVerifyRequestSchema.safeParse({ nonce: 'A'.repeat(chars as number) })
    expect(parsed.success).toBe(ok)
  })
})
