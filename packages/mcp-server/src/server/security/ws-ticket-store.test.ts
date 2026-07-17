import { describe, expect, it } from 'vitest'
import { createWsTicketStore } from './ws-ticket-store.js'

describe('createWsTicketStore', () => {
  it('mints a ticket bound to the provided scopes and clientId', () => {
    const store = createWsTicketStore()
    const { ticket, expiresIn } = store.mintTicket(['canvas:read', 'canvas:write'], 'client-a')
    expect(ticket).toEqual(expect.any(String))
    expect(ticket.length).toBeGreaterThan(0)
    expect(expiresIn).toBe(30)
  })

  it('redeems a fresh ticket exactly once, returning the bound scopes and clientId', () => {
    const store = createWsTicketStore()
    const { ticket } = store.mintTicket(['canvas:read'], 'client-a')

    expect(store.redeemTicket(ticket)).toEqual({ scopes: ['canvas:read'], clientId: 'client-a' })
  })

  it('rejects a replayed ticket on the second redemption (single-use)', () => {
    const store = createWsTicketStore()
    const { ticket } = store.mintTicket(['canvas:read'], 'client-a')

    expect(store.redeemTicket(ticket)).not.toBeNull()
    expect(store.redeemTicket(ticket)).toBeNull()
  })

  it('rejects an expired ticket', () => {
    let clock = 1_000_000
    const store = createWsTicketStore({ now: () => clock })
    const { ticket } = store.mintTicket(['canvas:read'], 'client-a')

    clock += 30_000 + 1
    expect(store.redeemTicket(ticket)).toBeNull()
  })

  it('rejects a forged/garbage string that was never minted', () => {
    const store = createWsTicketStore()
    expect(store.redeemTicket('not-a-real-ticket')).toBeNull()
  })

  it('rejects a raw OAuth access token presented as if it were a ticket', () => {
    const store = createWsTicketStore()
    // A real access token is a same-shaped random base64url string minted by
    // a different store entirely — it was never inserted into this map, so
    // it must fail exactly like any other unknown value.
    const rawAccessToken = 'oauth-access-token-value-not-minted-here'
    expect(store.redeemTicket(rawAccessToken)).toBeNull()
  })

  it('lazily prunes expired tickets on the next mint, reclaiming memory', () => {
    let clock = 1_000_000
    const store = createWsTicketStore({ now: () => clock })
    store.mintTicket(['canvas:read'], 'client-a')
    expect(store.size()).toBe(1)

    clock += 30_000 + 1
    store.mintTicket(['canvas:read'], 'client-b')

    // The first (expired) ticket is gone, not merely unredeemable — a
    // long-lived daemon must not accumulate one record per abandoned ticket.
    expect(store.size()).toBe(1)
  })
})
