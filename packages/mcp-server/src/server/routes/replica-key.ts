// This router serves a workspace's read-plane REPLICA POSTURE: the content
// key (POST .../replica-key) and, below, the per-workspace tier override
// that decides whether a key is handed out at all (PUT .../replica-tier).
//
// POST /api/workspaces/:workspaceId/replica-key (ADR-0042 decisions 1/3/5,
// ADR-0043 decision 3): hands a member's session the workspace's read-plane
// content key, per tier, and withholds it once L1 removal has taken effect.
//
// The grant is re-resolved here rather than read off the request context —
// the same shape ws-ticket.ts, runtime.ts and debug.ts already use — because
// only a PASSKEY-BOUND grant may hold this key, and the surrounding /api/*
// auth middleware only checks SCOPE, not the passkey binding. The decision
// itself — which grant kinds bypass membership, and why a member-less
// workspace keeps origin trust — is `workspace-access.ts`.
//
// This route issues a `bounded`-tier LEASE (a timestamp, nothing more) —
// there is deliberately no server-side lease table. The browser is what
// discards the key at lapse; this daemon holds the key in plaintext anyway
// (ADR-0043 decision 2: act-plane copy must never claim "cryptographically
// revoked"), so a lease is a courtesy to the browser, not a server-side
// enforcement mechanism.
//
// POST /api/workspaces/:workspaceId/replica-key/rotate (ADR-0042 decision 1,
// 2026-09-21 addendum): replaces the workspace's key+salt outright — see
// workspace-replica-key-store.ts's header for why REPLACE rather than an
// epoch bump. Gated at `runtime:admin`, the same bar as the tier route
// below: rotation is at least as consequential as a tier change, since
// every document key derived from the OLD pair (and every browser replica
// sealed under it) stops opening the instant this lands. Not gated on
// tier itself — a `no-offline` workspace must still be rotatable, or a
// compromised one becomes unfixable. Like the tier route, and unlike the
// plain key route above, the handler does not re-resolve the grant or
// check a passkey binding: the registry bar is the whole gate.
//
// PUT /api/workspaces/:workspaceId/replica-tier (ADR-0042 decision 1
// addendum, 2026-09-21): sets or clears the tier itself. Gated at
// `runtime:admin` (route-scope-registry.ts's `workspace replica-tier` rule)
// rather than the `workspace:write` the rest of a workspace's fields sit
// behind — a tier is a security-posture change about whether a copy may
// leave the daemon at all, an operator decision rather than something any
// member may relax for everyone. Unlike the key route above, the handler
// does not re-resolve the grant or check a passkey binding: the registry
// bar is the whole gate.
import type { MembershipRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import {
  type ReplicaKeyResponse,
  type RotateReplicaKeyResponse,
  replicaKeyResponseSchema,
  rotateReplicaKeyResponseSchema,
  type SetReplicaTierResponse,
  setReplicaTierRequestSchema,
  setReplicaTierResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { errorBody, invalidRequestBody } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getLogger } from '../log.js'
import { parseBearerAuthorizationHeader } from '../security/bearer-token.js'
import type { CredentialResolver } from '../security/credential-resolver.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import { membershipRefusal, workspaceAccess } from '../security/workspace-access.js'
import type { WorkspaceReplicaKeyStore } from '../security/workspace-replica-key-store.js'
import { badWorkspaceIdBody, unknownWorkspaceRefusal } from './membership.js'

const log = getLogger('replica-key')

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export interface ReplicaKeyRouterOptions {
  keys: WorkspaceReplicaKeyStore
  members: MemberProfileStore
  leaseTtlMs: number
  workspaceExists: (workspaceId: string) => Promise<boolean>
  credentialResolver: CredentialResolver
}

export function createReplicaKeyRouter({
  keys,
  members,
  leaseTtlMs,
  workspaceExists,
  credentialResolver,
}: ReplicaKeyRouterOptions) {
  const app = new Hono()

  app.post('/api/workspaces/:workspaceId/replica-key', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const invalidId = badWorkspaceIdBody(workspaceId)
    if (invalidId) return c.json(invalidId, 400)
    if (!(await workspaceExists(workspaceId))) {
      log.warning({ workspaceId, reason: 'unknown_workspace' }, 'replica-key refused')
      return c.json(unknownWorkspaceRefusal(workspaceId), 404)
    }

    const grant = await credentialResolver.resolve({
      secret: parseBearerAuthorizationHeader(c.req.header('authorization')),
      carrier: 'bearer',
      origin: c.req.header('origin'),
    })
    if (grant === null) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const access = await workspaceAccess(grant, workspaceId, members)
    if (access !== 'admitted') {
      log.warning({ workspaceId, reason: access }, 'replica-key refused')
      return c.json(membershipRefusal(access), 403)
    }

    const tier = await keys.effectiveTier(workspaceId)
    if (tier === 'no-offline') {
      log.warning({ workspaceId, reason: 'replica_not_allowed' }, 'replica-key refused')
      return c.json(
        {
          error: 'replica_not_allowed',
          message: 'this workspace does not allow an offline replica',
        } satisfies MembershipRefusal,
        403,
      )
    }

    const { key, salt, keyId } = await keys.keyFor(workspaceId)
    const response: ReplicaKeyResponse = replicaKeyResponseSchema.parse({
      workspaceKey: toBase64Url(key),
      workspaceKeySalt: toBase64Url(salt),
      tier,
      keyId,
      ...(tier === 'bounded'
        ? { leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString() }
        : {}),
    })
    return c.json(response, 200)
  })

  app.post('/api/workspaces/:workspaceId/replica-key/rotate', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const invalidId = badWorkspaceIdBody(workspaceId)
    if (invalidId) return c.json(invalidId, 400)
    if (!(await workspaceExists(workspaceId))) {
      log.warning({ workspaceId, reason: 'unknown_workspace' }, 'replica-key rotation refused')
      return c.json(unknownWorkspaceRefusal(workspaceId), 404)
    }

    const rotated = await keys.rotateKey(workspaceId)
    // A `warning`-level record, not `notice`: same audit-trail reasoning as
    // `replica-tier changed` below — an operator searches for this after
    // the fact, under the DEFAULT WHITEBOARD_LOG_LEVEL. Only the id, never
    // the key or salt bytes.
    log.warning({ workspaceId, keyId: rotated.keyId }, 'replica-key rotated')
    const response: RotateReplicaKeyResponse = rotateReplicaKeyResponseSchema.parse({
      keyId: rotated.keyId,
    })
    return c.json(response, 200)
  })

  app.put('/api/workspaces/:workspaceId/replica-tier', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const invalidId = badWorkspaceIdBody(workspaceId)
    if (invalidId) return c.json(invalidId, 400)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('invalid_body', 'the request body is not valid JSON'), 400)
    }
    const parsed = setReplicaTierRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }

    if (!(await workspaceExists(workspaceId))) {
      log.warning({ workspaceId, reason: 'unknown_workspace' }, 'replica-tier refused')
      return c.json(unknownWorkspaceRefusal(workspaceId), 404)
    }

    await keys.setTier(workspaceId, parsed.data.tier)
    const effectiveTier = await keys.effectiveTier(workspaceId)
    // A `warning`-level record, not `notice`: the default WHITEBOARD_LOG_LEVEL
    // is `warning`, and this is the durable audit trail an operator searches
    // for after the fact to learn a read-plane protection was lifted and by
    // when — a `notice` record would be silent under the default level.
    log.warning({ workspaceId, tier: parsed.data.tier, effectiveTier }, 'replica-tier changed')
    const response: SetReplicaTierResponse = setReplicaTierResponseSchema.parse({
      tier: parsed.data.tier,
      effectiveTier,
    })
    return c.json(response, 200)
  })

  return app
}
