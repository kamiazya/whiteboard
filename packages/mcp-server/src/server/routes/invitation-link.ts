/**
 * ADR-0049 decision 3: the link an invitation travels as, which
 * `invitePageUrl` spells for the web app's invite page to read back.
 */
import { invitePageUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
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
  return invitationLinkResponseSchema.parse({
    url: invitePageUrl(origin, token),
    expiresAt: new Date(invitation.expiresAt).toISOString(),
  })
}
