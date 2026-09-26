/**
 * ADR-0049 decision 3: the link an invitation travels as. It opens this
 * keeper's `/invite` page with the token in the fragment, which a browser
 * never sends to a server or puts in a Referer.
 */
import { invitationLinkResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import type { InvitationStore } from '../security/invitation-store.js'

// ponytail: one fixed lifetime; a body field when someone needs another.
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function issueInvitationLink(
  invitations: InvitationStore,
  origin: string,
  input: { readonly invitedBy: string; readonly workspaceId?: string },
) {
  const { token, invitation } = await invitations.createLink({
    ...input,
    now: Date.now(),
    ttlMs: INVITATION_TTL_MS,
  })
  const url = new URL('/invite', origin)
  url.hash = new URLSearchParams({ token }).toString()
  return invitationLinkResponseSchema.parse({
    url: url.toString(),
    expiresAt: new Date(invitation.expiresAt).toISOString(),
  })
}
