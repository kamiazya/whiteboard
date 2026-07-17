// Bridges an OAuth access token (RFC 6749 §7 bearer, resource-server side)
// to a WebSocket upgrade without ever placing that access token in the
// `Sec-WebSocket-Protocol` header (ADR-0005). A `Sec-WebSocket-Protocol`
// value travels in a browser request the same way a URL does — visible to
// proxies, browser history-adjacent APIs, and server access logs in a way a
// header a client controls more carefully is not. A short-lived, single-use
// ticket minted just-in-time keeps the long-lived OAuth bearer out of that
// surface entirely: the worst a leaked ticket buys an attacker is one
// connection, for a few seconds, before it either gets used or expires.
//
// This store is intentionally the mirror of oauth-authz-transactions.ts's
// grant bookkeeping: an in-memory Map, hash-free (the ticket value itself is
// the map key — unlike an access token, a ticket is never retained past its
// single redemption, so there is no long-lived record for a hash to protect),
// and compare-and-swap redemption so two concurrent upgrades racing the same
// ticket cannot both win.

import { randomBytes } from 'node:crypto'
import type { AuthScope } from './auth-strategy.js'

// Long enough for the browser to mint a ticket and immediately open the WS
// upgrade it names (sub-second in practice); short enough that a captured
// ticket is a stale credential well before a human could act on it.
const TICKET_TTL_MS = 30_000

interface WsTicketRecord {
  scopes: AuthScope[]
  clientId: string
  expiresAt: number
}

export interface RedeemedWsTicket {
  scopes: readonly AuthScope[]
  clientId: string
}

export interface WsTicketStore {
  // Mints an opaque, single-use ticket bound to the presented grant's own
  // scopes and clientId. Never widens beyond what was passed in — the
  // caller (the route handler) is responsible for deriving `scopes` from an
  // already-verified access grant, not from client-supplied input.
  mintTicket(scopes: readonly AuthScope[], clientId: string): { ticket: string; expiresIn: number }
  // Redeems a ticket exactly once. Returns null for anything unknown,
  // expired, or already-redeemed — including a raw OAuth access token or
  // any other garbage string, since those were never entries in this store.
  redeemTicket(ticket: string): RedeemedWsTicket | null
  // Live entry count, for the same "is this leaking memory" observability
  // the OAuth transaction store exposes via size().
  size(): number
}

export function createWsTicketStore(options?: { now?: () => number }): WsTicketStore {
  const now = options?.now ?? Date.now
  const tickets = new Map<string, WsTicketRecord>()

  // Lazy sweep on every mint, not a timer — the same posture as
  // oauth-authz-transactions.ts's pruneExpired, for the same reason: a
  // `setInterval` would keep this daemon's event loop alive for its whole
  // lifetime. A ticket past its TTL is already unredeemable
  // (redeemTicket re-checks expiresAt), so dropping it here is a memory
  // concern only.
  function pruneExpired(): void {
    const cutoff = now()
    for (const [value, record] of tickets) {
      if (record.expiresAt >= cutoff) continue
      tickets.delete(value)
    }
  }

  function mintTicket(
    scopes: readonly AuthScope[],
    clientId: string,
  ): { ticket: string; expiresIn: number } {
    pruneExpired()
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = now() + TICKET_TTL_MS
    tickets.set(ticket, {
      scopes: [...scopes],
      clientId,
      expiresAt,
    })
    return { ticket, expiresIn: TICKET_TTL_MS / 1000 }
  }

  function redeemTicket(ticket: string): RedeemedWsTicket | null {
    const record = tickets.get(ticket)
    if (!record) return null

    // Delete-on-redeem: Node's run-to-completion semantics make this
    // atomic — two concurrent upgrades racing the same ticket cannot both
    // win because whichever runs second finds the key already gone.
    tickets.delete(ticket)

    if (record.expiresAt < now()) return null
    return { scopes: [...record.scopes], clientId: record.clientId }
  }

  function size(): number {
    return tickets.size
  }

  return { mintTicket, redeemTicket, size }
}
