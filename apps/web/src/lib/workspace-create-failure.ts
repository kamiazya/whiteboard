import { membershipRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { messageOf } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

const GENERIC_FAILURE = 'Could not create the workspace. Nothing was created. Try again.'

// Read by CODE, as `membership-refusal.ts` does, not by the sentence: the
// sentence is the keeper's to reword. Structural rather than `instanceof
// DaemonApiError`, which would pull the whole daemon client into this chunk
// and defeat the seam's lazy import of it.
const refusalSchema = z.object({ status: z.literal(403), body: membershipRefusalSchema })

/**
 * What a person reads when a keeper refused to create a workspace or the call
 * failed. One function for every surface that creates one, so a refusal a
 * keeper can raise anywhere is worded the same wherever it lands.
 */
export function createFailureCopy(cause: unknown): string {
  const refusal = refusalSchema.safeParse(cause)
  if (refusal.success && refusal.data.body.error === 'requires_person_session') {
    return 'This session is not signed in as a person, so the server did not create a workspace. Nothing was created. Sign out, sign in again, and try once more.'
  }
  return messageOf(cause, GENERIC_FAILURE)
}
