// The local daemon's own half of membership (ADR-0041 S0-4): how a PERSON
// becomes a member there. A member is identified by a pinned passkey
// credential (webauthn-credential-store.ts), never by a paired browser
// origin, so adding one names a pinned passkey by origin + credentialId and
// a display name — not an invite flow. Listing, re-roling and removing a
// workspace's people are the API server mode shares (routes/workspace-
// people.ts, ADR-0049 decision 5); removal there is still L1 revocation,
// ending the person's passkey-bound sessions at once (people-keepers.ts).
//
// ACCEPTED V1 POSTURE: a paired browser session carries ALL_AUTH_SCOPES
// today (credential-resolver.ts), so any paired browser can manage members —
// the same reach it already has over pairing grants and credential pins
// (route-scope-registry.ts holds all three at the same runtime:admin bar).
// Narrowing what a pairing session may do is its own future increment.
// Person-level membership gates the read plane's KEY (a later slice), not
// this admin surface.
//
// ONE route here is barred differently, and it is the exception that shows
// what the posture above costs. `DELETE .../members-only` returns a
// workspace to ORIGIN TRUST — the only exit from the gate a revoke
// deliberately leaves standing (user decision 2026-09-21) — and its bar is
// `daemon-token-only`, judged by the grant's KIND rather than its scopes.
// That is forced rather than chosen: since a pairing grant carries every
// scope, `runtime:admin` would let any paired browser reopen the very gate
// that exists to stop an origin being trusted, so a scope-based bar here
// would be no bar at all. With a kind-based one, the party who can reopen a
// workspace is whoever holds the daemon token, which is whoever owns the
// data directory; a taken-over origin cannot open the gate for itself.
// `grantCoversRoute` (auth.ts) enforces it, and server mode refuses the
// variant outright — which matches, this router being local-daemon-only.
//
// Why the exit has to exist: an operator who removes the last membership,
// possibly their own, is otherwise locked out of their own workspace with
// no route back but editing the database by hand.

import {
  type AddMemberRequest,
  addMemberRequestSchema,
  type MemberProfileSummary,
  type MembershipRefusal,
  memberProfileSummarySchema,
  type ReopenOriginTrustResponse,
  reopenOriginTrustResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { errorBody, invalidRequestBody } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getLogger } from '../log.js'
import {
  type MemberProfile,
  type MemberProfileStore,
  passkeyBinding,
} from '../security/member-profile-store.js'
import type { WebAuthnCredentialStore } from '../security/webauthn-credential-store.js'
import { validateWorkspaceId, validationErrorBody } from '../validators.js'

const log = getLogger('membership')

function toSummary(profile: MemberProfile): MemberProfileSummary {
  return memberProfileSummarySchema.parse({
    profileId: profile.id,
    displayName: profile.displayName,
    credentials: profile.credentials,
    createdAt: new Date(profile.createdAt).toISOString(),
  })
}

/** A malformed workspaceId (path-traversal-shaped, non-ASCII, etc.) is a 400,
 *  not the uncaught ValidationError `workspaceExists` throws underneath —
 *  the same guard `files.ts`'s purge-dangling route applies before its own
 *  `workspaceExists` call. */
export function badWorkspaceIdBody(workspaceId: string): MembershipRefusal | null {
  try {
    validateWorkspaceId(workspaceId)
    return null
  } catch (err) {
    const body = validationErrorBody(err)
    if (body === null) throw err
    return { error: 'invalid_workspace_id', message: body.message } satisfies MembershipRefusal
  }
}

export function unknownWorkspaceRefusal(workspaceId: string): MembershipRefusal {
  return {
    error: 'unknown_workspace',
    message: `no such workspace: ${workspaceId}`,
  } satisfies MembershipRefusal
}

export interface MembershipRouterOptions {
  members: MemberProfileStore
  /** The passkeys paired origins have pinned (ADR-0039) — adding a member
   *  requires the named credential to already be pinned there. */
  credentials: WebAuthnCredentialStore
  /** Whether a workspace is registered at all — a refusal, not a mint, the
   *  same check the /api/v1 document routes use. */
  workspaceExists: (workspaceId: string) => Promise<boolean>
}

export function createMembershipRouter({
  members,
  credentials,
  workspaceExists,
}: MembershipRouterOptions) {
  const app = new Hono()

  app.post('/api/workspaces/:workspaceId/members', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const invalidId = badWorkspaceIdBody(workspaceId)
    if (invalidId) return c.json(invalidId, 400)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('invalid_body', 'the request body is not valid JSON'), 400)
    }
    const parsed = addMemberRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    const request: AddMemberRequest = parsed.data

    if (!(await workspaceExists(workspaceId))) {
      log.warning({ workspaceId, reason: 'unknown_workspace' }, 'membership refused')
      return c.json(unknownWorkspaceRefusal(workspaceId), 404)
    }

    let origin: string
    try {
      origin = new URL(request.origin).origin
    } catch {
      return c.json(errorBody('invalid_origin', 'origin must be a valid http(s) URL'), 400)
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
        } satisfies MembershipRefusal,
        404,
      )
    }

    const profile = await members.ensureProfile({
      binding: passkeyBinding(origin, request.credentialId),
      displayName: request.displayName,
    })
    await members.addMember(workspaceId, profile.id)
    return c.json(toSummary(profile), 201)
  })

  // DELETE, because that is literally what it does: it removes the
  // `workspaceMembersOnly` row `workspaceAccess` reads. The response says
  // what the marker WAS, so an operator asking twice can tell "I just
  // reopened it" from "it was already open" — the bar and the reason this
  // route exists at all are in the file header.
  app.delete('/api/workspaces/:workspaceId/members-only', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const invalidId = badWorkspaceIdBody(workspaceId)
    if (invalidId) return c.json(invalidId, 400)
    if (!(await workspaceExists(workspaceId))) {
      log.warning({ workspaceId, reason: 'unknown_workspace' }, 'membership refused')
      return c.json(unknownWorkspaceRefusal(workspaceId), 404)
    }

    const wasMembersOnly = await members.reopenToOriginTrust(workspaceId)
    // `notice`, at the same level as an L1 revoke: this widens who may read
    // a workspace, and nothing else records that it happened.
    log.notice({ workspaceId, wasMembersOnly }, 'membership.reopened-to-origin-trust')
    const response: ReopenOriginTrustResponse = reopenOriginTrustResponseSchema.parse({
      wasMembersOnly,
    })
    return c.json(response, 200)
  })

  return app
}
