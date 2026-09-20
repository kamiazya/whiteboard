// Membership routes (ADR-0041 S0-4): list, add, and L1-remove a workspace's
// members. A MEMBER is a PERSON, identified by a pinned passkey credential
// (webauthn-credential-store.ts) never by a paired browser origin — adding
// one is an explicit administrator action (an administrator names a pinned
// passkey by origin + credentialId and a display name), not an invite flow.
// Removal is L1 revocation (ADR-0042 decision 3): it ends that person's live
// passkey-bound sessions SYNCHRONOUSLY (tokens.revokeBoundTo), not at their
// next TTL check, and it leaves the passkey PIN itself alone — L1 is not L2.
//
// ACCEPTED V1 POSTURE: a paired browser session carries ALL_AUTH_SCOPES
// today (credential-resolver.ts), so any paired browser can manage members —
// the same reach it already has over pairing grants and credential pins
// (route-scope-registry.ts holds all three at the same runtime:admin bar).
// Narrowing what a pairing session may do is its own future increment.
// Person-level membership gates the read plane's KEY (a later slice), not
// this admin surface.
import {
  type AddMemberRequest,
  addMemberRequestSchema,
  type ListMembersResponse,
  listMembersResponseSchema,
  type MemberProfileSummary,
  memberProfileSummarySchema,
  type RemoveMemberResponse,
  removeMemberResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { Hono } from 'hono'
import { getLogger } from '../log.js'
import type { MemberProfile, MemberProfileStore } from '../security/member-profile-store.js'
import type { PairingTokenStore } from '../security/pairing-session.js'
import type { WebAuthnCredentialStore } from '../security/webauthn-credential-store.js'

const log = getLogger('membership')

function toSummary(profile: MemberProfile): MemberProfileSummary {
  return memberProfileSummarySchema.parse({
    profileId: profile.id,
    displayName: profile.displayName,
    credentials: profile.credentials,
    createdAt: new Date(profile.createdAt).toISOString(),
  })
}

export interface MembershipRouterOptions {
  members: MemberProfileStore
  tokens: PairingTokenStore
  /** The passkeys paired origins have pinned (ADR-0039) — adding a member
   *  requires the named credential to already be pinned there. */
  credentials: WebAuthnCredentialStore
  /** Whether a workspace is registered at all — a refusal, not a mint, the
   *  same check the /api/v1 document routes use. */
  workspaceExists: (workspaceId: string) => Promise<boolean>
}

export function createMembershipRouter({
  members,
  tokens,
  credentials,
  workspaceExists,
}: MembershipRouterOptions) {
  const app = new Hono()

  app.get('/api/workspaces/:workspaceId/members', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    if (!(await workspaceExists(workspaceId))) {
      log.warning({ workspaceId, reason: 'unknown_workspace' }, 'membership refused')
      return c.json(
        { error: 'unknown_workspace', message: `no such workspace: ${workspaceId}` },
        404,
      )
    }
    const list = await members.listMembers(workspaceId)
    const response: ListMembersResponse = listMembersResponseSchema.parse({
      members: list.map(toSummary),
    })
    return c.json(response, 200)
  })

  app.post('/api/workspaces/:workspaceId/members', async (c) => {
    const workspaceId = c.req.param('workspaceId')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const parsed = addMemberRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    const request: AddMemberRequest = parsed.data

    if (!(await workspaceExists(workspaceId))) {
      log.warning({ workspaceId, reason: 'unknown_workspace' }, 'membership refused')
      return c.json(
        { error: 'unknown_workspace', message: `no such workspace: ${workspaceId}` },
        404,
      )
    }

    let origin: string
    try {
      origin = new URL(request.origin).origin
    } catch {
      return c.json({ error: 'malformed origin' }, 400)
    }

    const pin = credentials.find(origin, request.credentialId)
    if (pin === null) {
      log.warning(
        { workspaceId, origin, credentialId: request.credentialId, reason: 'unknown_credential' },
        'membership refused',
      )
      return c.json(
        {
          error: 'unknown_credential',
          message: 'that passkey is not pinned for this origin',
        },
        404,
      )
    }

    const profile = await members.ensureProfile({
      origin,
      credentialId: request.credentialId,
      displayName: request.displayName,
    })
    await members.addMember(workspaceId, profile.id)
    return c.json(toSummary(profile), 201)
  })

  app.delete('/api/workspaces/:workspaceId/members/:profileId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const profileId = c.req.param('profileId')

    const { removed, credentials: boundCredentials } = await members.revokeL1Membership(
      workspaceId,
      profileId,
    )
    if (!removed) {
      log.warning({ workspaceId, profileId, reason: 'unknown_profile' }, 'membership refused')
      return c.json({ error: 'unknown_profile', message: 'no such member in this workspace' }, 404)
    }

    const sessionsEnded = tokens.revokeBoundTo(boundCredentials)
    log.notice({ workspaceId, profileId, sessionsEnded }, 'membership.l1-revoked')
    const response: RemoveMemberResponse = removeMemberResponseSchema.parse({
      removed: true,
      sessionsEnded,
    })
    return c.json(response, 200)
  })

  return app
}
