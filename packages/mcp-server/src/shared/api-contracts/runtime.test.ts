import { describe, expect, it } from 'vitest'
import { daemonPingResponseSchema } from './runtime.js'

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
