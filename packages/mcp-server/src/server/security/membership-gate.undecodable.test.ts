/**
 * The membership step fails CLOSED on a workspace handle it cannot decode: the
 * route is gated and carries a handle, so a handle that does not decode is a
 * request for some workspace the gate cannot name, and answering it like a
 * route with nothing to gate would admit it unchecked.
 */
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { type CapturedLogsHandle, captureLogsForTests } from '../log.js'
import type { ResolvedGrant } from './credential-resolver.js'
import type { MemberProfileStore } from './member-profile-store.js'
import { membershipRefusalFor } from './membership-gate.js'

// A member store that any lookup would fail on, so a 403 here cannot have come
// from a decision the store made about a person.
const NEVER_CONSULTED = new Proxy(
  {},
  {
    get(_target, key) {
      throw new Error(`the member store was consulted: ${String(key)}`)
    },
  },
) as MemberProfileStore

const GRANT: ResolvedGrant = { kind: 'external-bearer', scopes: [] }

let logs: CapturedLogsHandle | undefined
afterEach(() => {
  logs?.restore()
  logs = undefined
})

function gate() {
  const app = new Hono()
  app.all('*', async (c) => {
    const refusal = await membershipRefusalFor(c, GRANT, NEVER_CONSULTED)
    return refusal ?? c.text('admitted')
  })
  return app
}

describe('membershipRefusalFor', () => {
  it('refuses a workspace handle that does not decode, and logs which rule claimed it', async () => {
    logs = captureLogsForTests('warning')
    const res = await gate().request('http://x/api/workspaces/%E0%A4%A')

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'not_a_member' })
    expect(logs.records.map((r) => r.msg)).toContain(
      'membership refused: undecodable workspace handle',
    )
  })

  // The control: a route with no handle segment reaches the same gate and is
  // admitted, so the refusal above is the handle's and not the gate's default.
  it('admits a gated route that carries no handle segment', async () => {
    const res = await gate().request('http://x/api/workspaces')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('admitted')
  })
})
