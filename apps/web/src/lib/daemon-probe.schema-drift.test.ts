import { describe, expect, it } from 'vitest'
import { daemonPingResponseSchema as serverDaemonPingResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts-internal'
import { probeDaemon, probeFailureReasonSchema } from './daemon-probe.js'

// Test-only import of the server's source of truth for the ping response
// shape, via the declared `./api-contracts-internal` export subpath.
// apps/web keeps its own local Zod mirror (daemon-probe.ts) because
// packages/mcp-server/src/shared/api-contracts/runtime.ts is deliberately
// excluded from the published ./api-contracts barrel (it is not part of the
// npm-facing contract surface); `./api-contracts-internal` is a declared,
// non-published subpath scoped to this monorepo's own test code, kept
// separate so the barrel's semver liability doesn't widen. This test pins
// that mirror against silent field-level drift: a fixture the server schema
// accepts must also be accepted by the client-observable probe result, and
// vice versa for the success shape.
describe('daemon-probe schema drift pin', () => {
  it('a fixture accepted by the server daemonPingResponseSchema is treated as detected by probeDaemon', async () => {
    const serverFixture = { ok: true as const, instanceId: 'server-instance-1' }
    expect(serverDaemonPingResponseSchema.safeParse(serverFixture).success).toBe(true)

    const fetchMock = async () =>
      new Response(JSON.stringify(serverFixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const result = await probeDaemon('http://drift-pin.invalid', { fetch: fetchMock })
    expect(result).toEqual({ detected: true, instanceId: 'server-instance-1' })
  })

  it('the success shape produced by a detected probe result also parses under the server schema', () => {
    const clientObservedSuccessPayload = { ok: true as const, instanceId: 'client-instance-1' }
    expect(serverDaemonPingResponseSchema.safeParse(clientObservedSuccessPayload).success).toBe(
      true,
    )
  })

  it('widens the probe failure reason enum additively — a legacy pre-tier memo value still parses', () => {
    // Pins the reason set gained by the capability-tier slice ('blocked',
    // 'refused') as additive: a sessionStorage memo written by a pre-tier
    // build (reason: 'network') must still round-trip after the upgrade.
    expect(probeFailureReasonSchema.safeParse('network').success).toBe(true)
    expect(probeFailureReasonSchema.safeParse('timeout').success).toBe(true)
    expect(probeFailureReasonSchema.safeParse('http-error').success).toBe(true)
    expect(probeFailureReasonSchema.safeParse('malformed').success).toBe(true)
    expect(probeFailureReasonSchema.safeParse('blocked').success).toBe(true)
    expect(probeFailureReasonSchema.safeParse('refused').success).toBe(true)
  })
})
