import { errorBody } from '@kamiazya/whiteboard-server-core'
import type { Context, MiddlewareHandler } from 'hono'

/** Long enough for a sync write in flight to finish; a write chain retries after it. */
const RETRY_AFTER_SECONDS = 1

/**
 * How many requests carrying a content-sized body — a Loro update, a
 * promoted record, an uploaded file, an `/api/v1` document created from its
 * content — server mode reads at once, for one user and for everyone.
 *
 * Each such body is read whole before the workspace write lock serialises
 * the work it carries, so the body ceiling bounds one request and nothing
 * bounds how many are resident together: requests in parallel would hold
 * that many bodies, and a promote holds its text, the parsed JSON and the
 * decoded record besides. Sync writes are small and quick, and the web app's
 * write chain sends one at a time and retries a 429 after its `Retry-After`,
 * so a person editing from a few devices stays under the per-user cap while
 * a caller flooding the instance is refused before its bodies are buffered.
 * The local daemon has one person and applies neither.
 */
export const CONTENT_REQUEST_CAPS = { perUser: 4, total: 16 } as const
type ContentRequestCaps = { readonly perUser: number; readonly total: number }

/** Which cap refused a slot. */
type CapReached = 'per_user' | 'total'

/** A count of the content-sized requests one instance is reading, per user and in all. */
interface ContentSlots {
  /** The release for a slot `userId` now holds, or the cap that refused one. */
  take(userId: string | null): (() => void) | CapReached
}

// The one bucket every grant naming no user here shares: nothing tells two
// such callers apart, so each counted alone could hold the whole instance.
const NO_USER = Symbol('no user')

export function createContentSlots(caps: ContentRequestCaps): ContentSlots {
  let total = 0
  const byUser = new Map<string | typeof NO_USER, number>()
  return {
    take(userId) {
      const key = userId ?? NO_USER
      if (total >= caps.total) return 'total'
      const held = byUser.get(key) ?? 0
      if (held >= caps.perUser) return 'per_user'
      total += 1
      byUser.set(key, held + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        total -= 1
        const left = (byUser.get(key) ?? 1) - 1
        if (left === 0) byUser.delete(key)
        else byUser.set(key, left)
      }
    },
  }
}

interface ArmedSlots {
  readonly slots: ContentSlots
  /** Whose request this is; null for a grant that names no user, all of which count as one. */
  readonly userOf: (c: Context) => Promise<string | null>
  /** Told of each refusal, so the composition can log it with its own logger. */
  readonly refused: (userId: string | null, cap: CapReached) => void
}

/** The slots a request's composition armed, keyed by the request itself — the
 *  same per-request idiom as the membership gate's grant memo, since the route
 *  that reads the body is mounted far from the root that knows the caps. */
const armed = new WeakMap<Request, ArmedSlots>()

/** Arms content slots for every request this app serves, as server mode's root does. */
export function armContentSlots(arm: ArmedSlots): MiddlewareHandler {
  return async (c, next) => {
    armed.set(c.req.raw, arm)
    await next()
  }
}

/** How a slotted route answers a refusal; `/mcp` answers in JSON-RPC's shape instead. */
type RefusalAnswer = (c: Context, message: string) => Response

const apiRefusal: RefusalAnswer = (c, message) =>
  c.json(errorBody('too_many_requests', message), 429)

/**
 * Takes a content slot for this request, if its composition armed any: the
 * release to call once the handler is done, or the 429 that refuses it —
 * answered before any of the body is read.
 */
export async function takeContentSlot(
  c: Context,
  answer: RefusalAnswer = apiRefusal,
): Promise<(() => void) | Response> {
  const arm = armed.get(c.req.raw)
  if (arm === undefined) return () => {}
  const userId = await arm.userOf(c)
  const slot = arm.slots.take(userId)
  if (typeof slot === 'function') return slot
  arm.refused(userId, slot)
  c.header('Retry-After', String(RETRY_AFTER_SECONDS))
  const message =
    slot === 'per_user'
      ? 'this user already has as many large requests in flight as the keeper allows'
      : 'the keeper already has as many large requests in flight as it allows'
  return answer(c, message)
}
