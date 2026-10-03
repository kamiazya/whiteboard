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
 */
import { randomBytes } from 'node:crypto'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { sha256Hex } from '../../shared/sha256.js'
import type { TenantScoped } from '../store/db/tenant-database.js'

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
  openLink(
    token: string,
    now: number,
  ): Promise<{ ok: true; invitation: Invitation } | { ok: false; reason: LinkRefusal }>
  /** True for exactly one caller per invitation, and only before it expires. */
  redeem(invitationId: string, redeemedBy: string, now: number): Promise<boolean>
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

async function openLink(db: TenantScoped, token: string, now: number) {
  const row = await db
    .selectFrom('invitations')
    .selectAll()
    .where('tokenHash', '=', sha256Hex(token))
    .executeTakeFirst()
  if (row === undefined) return { ok: false as const, reason: 'unknown' as const }
  if (row.redeemedAt !== null) return { ok: false as const, reason: 'redeemed' as const }
  if (now >= row.expiresAt) return { ok: false as const, reason: 'expired' as const }
  return { ok: true as const, invitation: invitationSchema.parse(row) }
}

async function redeem(db: TenantScoped, invitationId: string, redeemedBy: string, now: number) {
  const updated = await db
    .updateTable('invitations')
    .set({ redeemedAt: now, redeemedBy })
    .where('id', '=', invitationId)
    .where('redeemedAt', 'is', null)
    .where('expiresAt', '>', now)
    .returning('id')
    .execute()
  return updated.length > 0
}

export function createInvitationStore(db: TenantScoped): InvitationStore {
  return {
    async createLink(input) {
      const token = randomBytes(32).toString('base64url')
      return { token, invitation: await insert(db, input, sha256Hex(token)) }
    },
    openLink: (token, now) => openLink(db, token, now),
    redeem: (invitationId, redeemedBy, now) => redeem(db, invitationId, redeemedBy, now),
  }
}
