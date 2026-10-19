import type { Context, MiddlewareHandler } from 'hono'
import { takeContentSlot } from './content-slots.js'
import { isEventStream, isListenRequest, releasedWhenDone } from './mcp-listen-streams.js'

const jsonRpcRefusal = (c: Context, message: string): Response =>
  c.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, 429)

/**
 * Runs the rest of the chain, then gives `release` back once the request is
 * answered — which, for a call answered as an event stream handed back while
 * the tool still runs, is when that stream ends, errors or is cancelled. A
 * `subscriptions/listen` stream carries no call and is counted by
 * `capListenStreams` instead, so it frees at once.
 */
async function holdUntilAnswered(
  c: Context,
  next: () => Promise<void>,
  release: () => void,
): Promise<void> {
  let riding = false
  try {
    await next()
    const body = c.res.body
    if (body !== null && isEventStream(c.res) && !isListenRequest(c)) {
      c.res = new Response(releasedWhenDone(body, release), c.res)
      riding = true
    }
  } finally {
    if (!riding) release()
  }
}

// A JSON-RPC body may be as large as `/mcp`'s 4 MiB ceiling, and is read
// whole before any tool runs, so it is held to the same content slots as
// `/api`'s content-sized bodies (`content-slots.ts`): taken after the caller is
// known and before the body limit reads, held until the call is answered.
// The SDK refuses a request whose `Mcp-Method` header disagrees with its
// body, so the header names what a stream is.
export function mcpContentSlot(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method.toUpperCase() !== 'POST') return next()
    const slot = await takeContentSlot(c, jsonRpcRefusal)
    if (slot instanceof Response) return slot
    await holdUntilAnswered(c, next, slot)
  }
}

/** How many JSON-RPC requests (messages with a method and an id) the body carries; at least 1. */
async function requestsIn(c: Context): Promise<number> {
  if (!c.req.header('content-type')?.toLowerCase().includes('application/json')) return 1
  let parsed: unknown
  try {
    parsed = await c.req.raw.clone().json()
  } catch {
    return 1
  }
  if (!Array.isArray(parsed)) return 1
  const requests = parsed.filter(
    (m) => typeof m === 'object' && m !== null && 'method' in m && 'id' in m,
  ).length
  return Math.max(requests, 1)
}

/**
 * Charges a JSON-RPC batch one content slot per request it carries, on top of
 * the one `mcpContentSlot` took for the body. The 2025-03-26 revision requires
 * a server to accept batches, and the SDK runs every request in one
 * concurrently — up to its batch ceiling of 100 — so a slot per POST would let
 * one caller run that many tool calls at once under a per-user cap of a few.
 * Charging per request keeps a compliant legacy client working while holding
 * it to the same bound as one sending its calls separately; a batch needing
 * more slots than are free is refused whole, before any of it runs. Mounted
 * after the body limit, since counting means reading the body.
 */
export function mcpBatchSlots(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method.toUpperCase() !== 'POST') return next()
    const extra = (await requestsIn(c)) - 1
    if (extra === 0) return next()
    const held: Array<() => void> = []
    const releaseAll = () => {
      for (const release of held) release()
    }
    for (let i = 0; i < extra; i += 1) {
      const slot = await takeContentSlot(c, jsonRpcRefusal)
      if (slot instanceof Response) {
        releaseAll()
        return slot
      }
      held.push(slot)
    }
    await holdUntilAnswered(c, next, releaseAll)
  }
}
