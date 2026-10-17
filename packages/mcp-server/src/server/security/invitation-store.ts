/**
 * ADR-0046 decision 6: invitations to a tenant, and (ADR-0049 decision 3)
 * into one of its workspaces. An invitation is a LINK: it carries a random
 * token the store hands back exactly once and keeps only the hash of.
 * Redeemed, it is what lets a new account become this tenant's user — the
 * admission decision (ADR-0046 decision 5) is still what decides whether that
 * account may sign in at all.
 *
 * Redemption is ONE conditional update (unredeemed and unexpired, in the
 * WHERE clause), so two concurrent redemptions of one link cannot both win:
 * the database answers which update touched the row.
 *
 * A link speaks with its inviter's authority, so the same WHERE clause asks
 * that they still hold it: an active owner of the workspace it invites into,
 * or an active administrator for one into the tenant alone. Removing,
 * demoting, dismissing or deactivating the inviter therefore kills every
 * link they minted, with nothing to sweep, and a removal racing a redemption
 * cannot let the link through after it.
 */
import { randomBytes } from 'node:crypto'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import type { ExpressionBuilder } from 'kysely'
import { z } from 'zod'
import { sha256Hex } from '../../shared/sha256.js'
import type { DatabaseSchema } from '../store/db/schema.js'
import type { TenantScoped } from '../store/db/tenant-database.js'
import { INVITATION_TOKEN_BYTES } from './invitation-token.js'
import type { AuthenticatorBinding } from './member-profile-store.js'

const invitationSchema = z
  .object({
    id: z.string().min(1),
    invitedBy: z.string().min(1),
    workspaceId: z.string().nullable(),
    createdAt: z.number(),
    expiresAt: z.number(),
  })
  .strip()

type Invitation = z.infer<typeof invitationSchema>

type LinkRefusal = 'unknown' | 'expired' | 'redeemed'

type OpenedLink = { ok: true; invitation: Invitation } | { ok: false; reason: LinkRefusal }

interface IssueInput {
  readonly invitedBy: string
  /** ADR-0049 decision 3: the workspace accepting it joins; absent, the tenant alone. */
  readonly workspaceId?: string
  readonly now: number
  readonly ttlMs: number
}

export interface InvitationStore {
  /** The token is returned here and nowhere else; the store keeps its hash. */
  createLink(input: IssueInput): Promise<{ token: string; invitation: Invitation }>
  openLink(token: string, now: number): Promise<OpenedLink>
  /** `openLink` for a caller that kept only the token's hash. */
  openLinkByHash(tokenHash: string, now: number): Promise<OpenedLink>
  /** True for exactly one caller per invitation, and only before it expires. */
  redeem(invitationId: string, redeemedBy: string, now: number): Promise<boolean>
  /** The links into `workspaceId` neither redeemed nor expired, oldest first. */
  listPending(workspaceId: string, now: number): Promise<Invitation[]>
  /** Takes back an unredeemed link into `workspaceId`; false when there is none by that id. */
  revoke(workspaceId: string, invitationId: string): Promise<boolean>
}

async function insert(db: TenantScoped, input: IssueInput, tokenHash: string): Promise<Invitation> {
  const invitation: Invitation = {
    id: generateDocumentId(),
    invitedBy: input.invitedBy,
    workspaceId: input.workspaceId ?? null,
    createdAt: input.now,
    expiresAt: input.now + input.ttlMs,
  }
  await db
    .insertInto('invitations')
    .values({
      ...invitation,
      tokenHash,
      redeemedAt: null,
      redeemedBy: null,
    })
    .execute()
  return invitation
}

async function openLink(db: TenantScoped, tokenHash: string, now: number): Promise<OpenedLink> {
  const row = await db
    .selectFrom('invitations')
    .selectAll()
    .where('tokenHash', '=', tokenHash)
    .executeTakeFirst()
  if (row === undefined) return { ok: false as const, reason: 'unknown' as const }
  if (row.redeemedAt !== null) return { ok: false as const, reason: 'redeemed' as const }
  if (now >= row.expiresAt) return { ok: false as const, reason: 'expired' as const }
  return { ok: true as const, invitation: invitationSchema.parse(row) }
}

type InviterScope = ExpressionBuilder<
  DatabaseSchema & { inviter: DatabaseSchema['memberProfiles'] },
  'invitations' | 'inviter'
>

// The configuration's administrators are bindings, not rows, so they are
// matched through the inviter's account (administrator-check.ts).
function configuredAdministrator(eb: InviterScope, configured: readonly AuthenticatorBinding[]) {
  return eb.exists(
    eb
      .selectFrom('accountBindings')
      .select('accountBindings.accountId')
      .whereRef('accountBindings.accountId', '=', 'inviter.accountId')
      .where((b) =>
        b.or(
          configured.map((admin) =>
            b.and([
              b('accountBindings.authenticator', '=', admin.authenticator),
              b('accountBindings.subject', '=', admin.subject),
            ]),
          ),
        ),
      ),
  )
}

function tenantAdministrator(eb: InviterScope, configured: readonly AuthenticatorBinding[]) {
  const appointed = eb.exists(
    eb
      .selectFrom('tenantAdministrators')
      .select('tenantAdministrators.profileId')
      .whereRef('tenantAdministrators.profileId', '=', 'inviter.id'),
  )
  return configured.length === 0
    ? appointed
    : eb.or([appointed, configuredAdministrator(eb, configured)])
}

function workspaceOwner(eb: InviterScope) {
  return eb.exists(
    eb
      .selectFrom('workspaceMemberships')
      .select('workspaceMemberships.profileId')
      .whereRef('workspaceMemberships.workspaceId', '=', 'invitations.workspaceId')
      .whereRef('workspaceMemberships.profileId', '=', 'inviter.id')
      .where('workspaceMemberships.role', '=', 'owner'),
  )
}

// The guard redemption carries: the inviter still holds the authority the
// link was minted with.
function inviterStillInvites(configured: readonly AuthenticatorBinding[]) {
  return (eb: ExpressionBuilder<DatabaseSchema, 'invitations'>) =>
    eb.exists(
      eb
        .selectFrom('memberProfiles as inviter')
        .select('inviter.id')
        .whereRef('inviter.id', '=', 'invitations.invitedBy')
        .where('inviter.deactivatedAt', 'is', null)
        .where((inner) =>
          inner.or([
            inner.and([inner('invitations.workspaceId', 'is not', null), workspaceOwner(inner)]),
            inner.and([
              inner('invitations.workspaceId', 'is', null),
              tenantAdministrator(inner, configured),
            ]),
          ]),
        ),
    )
}

async function redeem(
  db: TenantScoped,
  configured: readonly AuthenticatorBinding[],
  invitationId: string,
  redeemedBy: string,
  now: number,
) {
  const updated = await db
    .updateTable('invitations')
    .set({ redeemedAt: now, redeemedBy })
    .where('id', '=', invitationId)
    .where('redeemedAt', 'is', null)
    .where('expiresAt', '>', now)
    .where(inviterStillInvites(configured))
    .returning('id')
    .execute()
  return updated.length > 0
}

async function listPending(db: TenantScoped, workspaceId: string, now: number) {
  const rows = await db
    .selectFrom('invitations')
    .select(['id', 'invitedBy', 'workspaceId', 'createdAt', 'expiresAt'])
    .where('workspaceId', '=', workspaceId)
    .where('redeemedAt', 'is', null)
    .where('expiresAt', '>', now)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute()
  return rows.map((row) => invitationSchema.parse(row))
}

// A revoked link is deleted, so it then opens as one never issued. A
// redeemed one is kept: it records who let that person in.
async function revoke(db: TenantScoped, workspaceId: string, invitationId: string) {
  const deleted = await db
    .deleteFrom('invitations')
    .where('id', '=', invitationId)
    .where('workspaceId', '=', workspaceId)
    .where('redeemedAt', 'is', null)
    .returning('id')
    .execute()
  return deleted.length > 0
}

interface InvitationStoreOptions {
  /** The administrators the sign-in configuration names (ADR-0049 decision 2). */
  readonly configuredAdministrators?: readonly AuthenticatorBinding[]
}

export function createInvitationStore(
  db: TenantScoped,
  options: InvitationStoreOptions = {},
): InvitationStore {
  const configured = options.configuredAdministrators ?? []
  return {
    async createLink(input) {
      const token = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url')
      return { token, invitation: await insert(db, input, sha256Hex(token)) }
    },
    openLink: (token, now) => openLink(db, sha256Hex(token), now),
    openLinkByHash: (tokenHash, now) => openLink(db, tokenHash, now),
    redeem: (invitationId, redeemedBy, now) =>
      redeem(db, configured, invitationId, redeemedBy, now),
    listPending: (workspaceId, now) => listPending(db, workspaceId, now),
    revoke: (workspaceId, invitationId) => revoke(db, workspaceId, invitationId),
  }
}
