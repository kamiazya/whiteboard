// POST /api/ws-ticket: mints the connection ticket a hosted-origin caller
// exchanges its OAuth access token for, ahead of a WebSocket upgrade
// (ADR-0005 — see ws-ticket-store.ts for why a ticket exists at all instead
// of putting the access token straight into Sec-WebSocket-Protocol).
//
// This route requires a *grant* bearer specifically, not the shared daemon
// token: a daemon-token holder already has a full-authority WS path (the
// `daemon-token.` subprotocol) and has no ticket to bridge to. The
// surrounding /api/* auth middleware (createDaemonAuthMiddleware) still
// gates entry to this route per route-scope-registry.ts, but the handler
// re-parses the bearer itself because it needs the grant's *scopes* and
// *clientId* to bind the minted ticket to — information the middleware does
// not thread through.

import { Hono } from 'hono'
import { z } from 'zod'
import type { OAuthTransactionStore } from '../security/oauth-authz-transactions.js'
import type { WsTicketStore } from '../security/ws-ticket-store.js'
import { parseBearerAuthorizationHeader } from './auth.js'

export const mintWsTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresIn: z.number().positive(),
})

export type MintWsTicketResponse = z.infer<typeof mintWsTicketResponseSchema>

export interface WsTicketRouterOptions {
  // Absent when the operator has not configured the hosted-origin OAuth
  // surface at all (empty-by-default oauthClientRegistry) — in which case no
  // presented bearer can ever be a valid grant, so every request 401s.
  grantStore?: OAuthTransactionStore
  ticketStore: WsTicketStore
}

export function createWsTicketRouter(options: WsTicketRouterOptions) {
  const app = new Hono()

  app.post('/api/ws-ticket', (c) => {
    const presented = parseBearerAuthorizationHeader(c.req.header('authorization'))
    if (presented === null || options.grantStore === undefined) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const grant = options.grantStore.verifyAccessToken(presented)
    if (grant === null) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const { ticket, expiresIn } = options.ticketStore.mintTicket(grant.scopes, grant.clientId)
    return c.json(
      mintWsTicketResponseSchema.parse({ ticket, expiresIn } satisfies MintWsTicketResponse),
    )
  })

  return app
}
