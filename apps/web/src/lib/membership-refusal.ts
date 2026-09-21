/**
 * S8 slice 3 (ADR-0041/0042): what the daemon's membership gate looks like
 * from this browser, and the once-only passkey-bind loop that answers it.
 *
 * `membershipRefusal` reads the refusal by CODE, through
 * `membershipRefusalSchema`, never by matching the sentence — the sentence
 * is free to change (and does, per refusal) without breaking this branch.
 */
import { membershipRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { DaemonApiError } from './daemon-api-client.js'

/** The two membership refusal codes this slice acts on — every other code
 *  (unknown_workspace, unknown_credential, …) is left to the generic
 *  `loadError` path, unclassified. */
export type MembershipRefusalAction = 'requires_person_session' | 'not_a_member'

export function membershipRefusal(err: unknown): MembershipRefusalAction | null {
  if (!(err instanceof DaemonApiError)) return null
  const parsed = membershipRefusalSchema.safeParse(err.body)
  if (!parsed.success) return null
  return parsed.data.error === 'requires_person_session' || parsed.data.error === 'not_a_member'
    ? parsed.data.error
    : null
}

/**
 * Runs `load()`; on a `requires_person_session` refusal it binds the passkey
 * ONCE (via `bind`, guarded by the caller-owned `guard`) and retries `load()`
 * exactly once more. Any other outcome — a second refusal, a failed bind, an
 * already-attempted guard, or a non-refusal error — rethrows the ORIGINAL
 * error unchanged, so a caller branching on it still sees the refusal it
 * asked about rather than a bind-failure wrapper.
 */
export async function withOnePasskeyBind<T>(
  load: () => Promise<T>,
  bind: () => Promise<{ ok: boolean }>,
  guard: { attempted: boolean },
): Promise<T> {
  try {
    return await load()
  } catch (err) {
    if (membershipRefusal(err) !== 'requires_person_session' || guard.attempted) throw err
    guard.attempted = true
    const outcome = await bind()
    if (!outcome.ok) throw err
    return await load()
  }
}

/** The one jargon-free sentence for a page that still needs its passkey bound. */
export const PASSKEY_NEEDED_COPY = {
  body: 'This workspace only opens for its members. Confirm it is you with the passkey registered for this daemon, then try again.',
  action: 'Try again',
} as const
