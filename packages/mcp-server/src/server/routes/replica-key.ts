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
import type { MembershipRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import {
  type ReplicaKeyResponse,
  replicaKeyResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
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

    const { key, salt } = await keys.keyFor(workspaceId)
    const response: ReplicaKeyResponse = replicaKeyResponseSchema.parse({
      workspaceKey: toBase64Url(key),
      workspaceKeySalt: toBase64Url(salt),
      tier,
      ...(tier === 'bounded'
        ? { leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString() }
        : {}),
    })
    return c.json(response, 200)
  })

  return app
}
