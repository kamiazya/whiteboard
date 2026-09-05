import {
  TICKET_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import { describe, expect, it } from 'vitest'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import { createOAuthTransactionStore } from '../security/oauth-authz-transactions.js'
import { createWsTicketStore } from '../security/ws-ticket-store.js'
import { authorizeWsUpgrade } from './ws-auth.js'
import { createWsTicketRouter } from './ws-ticket.js'

describe('POST /api/ws-ticket', () => {
  it('mints a ticket bound to the presented grant scopes and clientId', async () => {
    const grantStore = createOAuthTransactionStore()
    const ticketStore = createWsTicketStore()
    const { accessToken } = grantStore.mintAccessToken(['canvas:read', 'canvas:write'], 'client-a')
    const app = createWsTicketRouter({ grantStore, ticketStore })

    const res = await app.request('/api/ws-ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ticket: expect.any(String), expiresIn: 30 })
    expect(ticketStore.redeemTicket(body.ticket)).toEqual({
      scopes: ['canvas:read', 'canvas:write'],
      clientId: 'client-a',
    })
  })

  it('refuses with 401 when no Authorization header is presented', async () => {
    const grantStore = createOAuthTransactionStore()
    const ticketStore = createWsTicketStore()
    const app = createWsTicketRouter({ grantStore, ticketStore })

    const res = await app.request('/api/ws-ticket', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('refuses with 401 for a forged bearer that verifies against no grant', async () => {
    const grantStore = createOAuthTransactionStore()
    const ticketStore = createWsTicketStore()
    const app = createWsTicketRouter({ grantStore, ticketStore })

    const res = await app.request('/api/ws-ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer totally-forged-token' },
    })
    expect(res.status).toBe(401)
  })

  it('refuses with 401 for a revoked grant', async () => {
    const grantStore = createOAuthTransactionStore()
    const ticketStore = createWsTicketStore()
    const { accessToken } = grantStore.mintAccessToken(['canvas:read'], 'client-a')
    const grant = grantStore.verifyAccessToken(accessToken)
    if (!grant) throw new Error('expected a live grant')
    grantStore.revokeGrant(grant.grantId)
    const app = createWsTicketRouter({ grantStore, ticketStore })

    const res = await app.request('/api/ws-ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(401)
  })

  it('refuses with 401 when no grantStore is configured at all (OAuth surface unmounted)', async () => {
    const ticketStore = createWsTicketStore()
    const app = createWsTicketRouter({ ticketStore })

    const res = await app.request('/api/ws-ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer whatever' },
    })
    expect(res.status).toBe(401)
  })

  it('full flow: mint via the route, then the minted ticket authorizes a WS upgrade with narrowed scopes', async () => {
    const grantStore = createOAuthTransactionStore()
    const ticketStore = createWsTicketStore()
    const { accessToken } = grantStore.mintAccessToken(['canvas:read'], 'client-a')
    const app = createWsTicketRouter({ grantStore, ticketStore })

    const res = await app.request('/api/ws-ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const { ticket } = await res.json()

    const decision = authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
      },
      undefined,
      [],
      ticketStore.redeemTicket,
    )
    expect(decision).toEqual({
      accept: true,
      protocol: WHITEBOARD_WS_PROTOCOL,
      scopes: ['canvas:read'],
    })
    expect(decision.scopes).not.toEqual(ALL_AUTH_SCOPES)
  })
})
