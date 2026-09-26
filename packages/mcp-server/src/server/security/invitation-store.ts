/**
 * ADR-0046 decision 6: invitations to a tenant, and (ADR-0049 decision 3)
 * into one of its workspaces. A LINK carries a random
 * token the store hands back exactly once and keeps only the hash of; an
 * EMAIL invitation names an address a provider must later assert verified.
 * Either one, redeemed, is what lets a new account become this tenant's user
 * — the admission decision (ADR-0046 decision 5) is still what decides
 * whether that account may sign in at all.
 *
 * Redemption is ONE conditional update (unredeemed and unexpired, in the
 * WHERE clause), so two concurrent redemptions of one link cannot both win:
 * the database answers which update touched the row.
 */
import { createHash, randomBytes } from 'node:crypto'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { TenantScoped } from '../store/db/tenant-database.js'

const invitationSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().nullable(),
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
  createForEmail(input: IssueInput & { readonly email: string }): Promise<Invitation>
  openLink(
    token: string,
    now: number,
  ): Promise<{ ok: true; invitation: Invitation } | { ok: false; reason: LinkRefusal }>
  /** An unredeemed, unexpired invitation addressed to `email`, if any. */
  openForEmail(email: string, now: number): Promise<Invitation | null>
  /** True for exactly one caller per invitation, and only before it expires. */
  redeem(invitationId: string, redeemedBy: string, now: number): Promise<boolean>
  revoke(invitationId: string): Promise<boolean>
}

const emailSchema = z.string().email()

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

async function insert(
  db: TenantScoped,
  input: IssueInput,
  kind: { tokenHash: string } | { email: string },
): Promise<Invitation> {
  const invitation: Invitation = {
    id: generateDocumentId(),
    email: 'email' in kind ? kind.email : null,
    invitedBy: input.invitedBy,
    workspaceId: input.workspaceId ?? null,
    createdAt: input.now,
    expiresAt: input.now + input.ttlMs,
  }
  await db
    .insertInto('invitations')
    .values({
      ...invitation,
      tokenHash: 'tokenHash' in kind ? kind.tokenHash : null,
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
    .where('tokenHash', '=', hashToken(token))
    .executeTakeFirst()
  if (row === undefined) return { ok: false as const, reason: 'unknown' as const }
  if (row.redeemedAt !== null) return { ok: false as const, reason: 'redeemed' as const }
  if (now >= row.expiresAt) return { ok: false as const, reason: 'expired' as const }
  return { ok: true as const, invitation: invitationSchema.parse(row) }
}

async function openForEmail(db: TenantScoped, email: string, now: number) {
  const row = await db
    .selectFrom('invitations')
    .selectAll()
    .where('email', '=', email.toLowerCase())
    .where('redeemedAt', 'is', null)
    .where('expiresAt', '>', now)
    .orderBy('createdAt', 'desc')
    .executeTakeFirst()
  return row === undefined ? null : invitationSchema.parse(row)
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

async function revoke(db: TenantScoped, invitationId: string) {
  const deleted = await db
    .deleteFrom('invitations')
    .where('id', '=', invitationId)
    .returning('id')
    .execute()
  return deleted.length > 0
}

export function createInvitationStore(db: TenantScoped): InvitationStore {
  return {
    async createLink(input) {
      const token = randomBytes(32).toString('base64url')
      return { token, invitation: await insert(db, input, { tokenHash: hashToken(token) }) }
    },
    // async, so a malformed address rejects like every other failure here
    // rather than throwing before a promise exists.
    createForEmail: async (input) =>
      insert(db, input, { email: emailSchema.parse(input.email).toLowerCase() }),
    openLink: (token, now) => openLink(db, token, now),
    openForEmail: (email, now) => openForEmail(db, email, now),
    redeem: (invitationId, redeemedBy, now) => redeem(db, invitationId, redeemedBy, now),
    revoke: (invitationId) => revoke(db, invitationId),
  }
}
