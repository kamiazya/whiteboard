// Single declarative place for "what scope does this WebSocket operation
// require" — the WS-side counterpart to route-scope-registry.ts.
//
// Before this module, the WebSocket authenticated once at upgrade
// (`authorizeWsUpgrade`) and then treated every subsequent frame as
// authorized: a binary Loro update (a canvas mutation) and a `client_ready`
// control message were dispatched identically once the socket was open.
// ADR-0005 names this precisely as the likely way scope enforcement ships
// broken — "the WebSocket authenticates once at upgrade and then accepts
// every message". This registry gives every client-originated WS operation
// an explicit required-scope declaration so `routes/ws.ts` can check it per
// message instead of only at the handshake.
//
// `ws-scope-registry.test.ts` walks every literal in
// `clientTextMessageSchema`'s discriminated union (`shared/ws-messages.ts`)
// and asserts each one has an entry here — the same "exhaustive Zod union
// vs registry" guard shape used elsewhere in this codebase.

import type { ClientTextMessage } from '../../shared/ws-messages.js'
import { type AuthScope, hasRequiredScopes } from './auth-strategy.js'

export { hasRequiredScopes }

// A binary WS frame is always a Loro CRDT update — a canvas mutation. It has
// no `type` field to key a registry on, so it gets a fixed requirement
// rather than a lookup table entry.
export const WS_BINARY_UPDATE_REQUIRED_SCOPES: readonly AuthScope[] = ['canvas:write']

// Every client→server text message is a read-only control/signal frame
// today (readiness, tracing metadata, or a response to a request the server
// itself sent) — none of them mutate the canvas directly, so `canvas:read`
// is sufficient for all four. Declared as a per-type map (not a single
// constant) so a future message type must add its own entry rather than
// silently inheriting this one.
export const WS_CLIENT_TEXT_MESSAGE_REQUIRED_SCOPES: Record<
  ClientTextMessage['type'],
  readonly AuthScope[]
> = {
  client_ready: ['canvas:read'],
  export_response: ['canvas:read'],
  viewport_response: ['canvas:read'],
  ws_trace: ['canvas:read'],
}

export function requiredScopesForClientTextMessage(
  type: ClientTextMessage['type'],
): readonly AuthScope[] {
  return WS_CLIENT_TEXT_MESSAGE_REQUIRED_SCOPES[type]
}
