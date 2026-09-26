/**
 * ADR-0041's L1 subject: a MemberProfile is a PERSON, identified by the
 * passkey credentials the daemon has already pinned
 * (webauthn-credential-store.ts) — never by a paired browser origin. A
 * profile holds no key material; a credential id is only a public handle
 * (decision 1).
 *
 * ADR-0045 splits that person in two. The profile is the USER — who they are
 * inside this store's tenant — and the credential resolves to an ACCOUNT, the
 * keeper-wide login identity, through `accountBindings`. A user row names its
 * account; nothing keeper-wide names a tenant, so a lookup always goes
 * binding -> account -> this tenant's user, and an account with no user here
 * is nobody here.
 *
 * `workspaceMemberships` is a plain DB row, deliberately OUTSIDE the
 * CRDT-synced workspace record (ADR-0019), so a sync merge cannot resurrect a
 * row this store deleted. Revocation (`revokeL1Membership`) is a plain
 * DELETE — no tombstone — because reversing one costs nothing (ADR-0042
 * decision 3).
 *
 * `workspaceMembersOnly` is the one row a revoke NEVER touches (user
 * decision 2026-09-21): once a workspace has had a member, `membersOnly`
 * stays true even after the last one is removed, so `workspaceAccess` does
 * not fall back to origin trust. See the 0030 migration for why it is its
 * own table rather than a column on `workspaces`.
 *
 * `reopenToOriginTrust` is its ONLY exit, and it is deliberately not
 * reachable from a revoke: a gate that reopened whenever the last member
 * left would be no gate at all. It is barred to the daemon token alone
 * (`route-scope-registry.ts`'s `daemon-token-only`), so the party who can
 * reopen a workspace is whoever owns the data directory — never an origin
 * that has been taken over, and never a paired browser.
 *
 * FAIL-CLOSED HERE MEANS SCOPE OF CONSULTATION, NOT A PERMISSIVE DEFAULT: a
 * caller never consults `isWorkspaceMember` for an `anonymous` or
 * `daemon-token` grant — those bypass membership entirely, mirroring
 * `grantCoversRoute`'s own full-authority bypass in routes/auth.ts. So an
 * empty table correctly means "nobody is a member", and there is
 * deliberately NO seeded owner row, at migration time or anywhere else.
 *
 * This diverges on purpose from pairing-grant-store.ts and
 * webauthn-credential-store.ts, which are Zod-validated JSON files that
 * degrade to empty on a corrupt read (a dead daemon is worse than a lost
 * pin). This store is DB rows: a corrupt database never reaches this seam at
 * all, because the migrator already refuses to boot on one
 * (`IncompatibleDatabaseError`). Do not "fix" this back to a degrade-to-empty
 * read — there is nothing here to degrade.
 */

import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { inTenantTransaction, type TenantScoped } from '../store/db/tenant-database.js'

const memberProfileRowSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    accountId: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number(),
    deactivatedAt: z.number().nullable(),
  })
  .strict()

const profileCredentialSchema = z
  .object({ origin: z.string().min(1), credentialId: z.string().min(1) })
  .strict()

/**
 * Who an authenticator vouched for (ADR-0045 decision 15, ADR-0046): which
 * authenticator, and the subject it vouched for. Resolving a person always
 * goes through one of these, whatever produced it.
 */
export interface AuthenticatorBinding {
  readonly authenticator: string
  readonly subject: string
}

// The built-in authenticator. Its subject is the pin's own identity, so a
// credential under two origins stays two claims — the passkey's rpId is its
// hostname, and two ports on one host share it.
const PASSKEY_AUTHENTICATOR = 'passkey'
const passkeySubjectSchema = z.tuple([z.string().min(1), z.string().min(1)])

export function passkeyBinding(origin: string, credentialId: string): AuthenticatorBinding {
  return { authenticator: PASSKEY_AUTHENTICATOR, subject: JSON.stringify([origin, credentialId]) }
}

const memberProfileSchema = memberProfileRowSchema.omit({ accountId: true }).extend({
  credentials: z.array(profileCredentialSchema),
})

export type MemberProfile = z.infer<typeof memberProfileSchema>
type MembershipStatus = 'member' | 'not-a-member'

interface EnsureProfileInput {
  binding: AuthenticatorBinding
  displayName: string
}

type MembershipRole = 'owner' | 'member'

export interface MemberProfileStore {
  /** This tenant's user for whoever `binding` resolves to; null when the
   *  binding names no account, an account with no user here, or a user an
   *  administrator has deactivated — so every gate refuses them unasked. */
  profileForBinding(binding: AuthenticatorBinding): Promise<MemberProfile | null>
  /** True when `binding` resolves to a user here who is deactivated: what
   *  sign-in asks so it can say so instead of treating them as a newcomer. */
  isDeactivated(binding: AuthenticatorBinding): Promise<boolean>
  ensureProfile(input: EnsureProfileInput): Promise<MemberProfile>
  listMembers(workspaceId: string): Promise<MemberProfile[]>
  /** Every user this tenant has, oldest first — what an operator or an
   *  administrator picks from. */
  listUsers(): Promise<{ id: string; displayName: string; deactivated: boolean }[]>
  addMember(workspaceId: string, profileId: string): Promise<void>
  /** The passkeys a user holds, which a local daemon's sessions are bound to. */
  passkeysOf(profileId: string): Promise<{ origin: string; credentialId: string }[]>
  revokeL1Membership(
    workspaceId: string,
    profileId: string,
  ): Promise<{ removed: boolean; credentials: { origin: string; credentialId: string }[] }>
  isWorkspaceMember(workspaceId: string, profileId: string): Promise<MembershipStatus>
  /** This user's role in the workspace, or null when they are not a member. */
  membershipRole(workspaceId: string, profileId: string): Promise<MembershipRole | null>
  /** True once this workspace has ever had a member — never reverts on revoke. */
  membersOnly(workspaceId: string): Promise<boolean>
  /**
   * Returns a workspace to ORIGIN TRUST by clearing the `membersOnly`
   * marker, and answers whether there was one to clear.
   *
   * The one operation that undoes what a revoke deliberately leaves
   * standing (user decision 2026-09-21, ADR-0042 decision 3's escape). It
   * exists because the gate has no other exit: an operator who removed the
   * last membership — possibly their own — is otherwise locked out of their
   * own workspace with no route back but editing the database by hand.
   *
   * It does NOT touch `workspaceMemberships`. Reopening widens who may
   * read; it does not remove the people who already could, and folding
   * those together would make one call two decisions with the second one
   * silent.
   *
   * A workspace re-closes on its next `addMember`, since the ordinary
   * membership path re-inserts the marker — so this is a one-shot rather
   * than a mode a workspace sits in. Nothing records that it happened,
   * which is the honest limit: there is no audit log here to write to.
   */
  reopenToOriginTrust(workspaceId: string): Promise<boolean>
}

// Inserts the membership row and, on a workspace's FIRST membership ever,
// its `workspaceMembersOnly` marker — in one transaction so the two can
// never disagree about whether a workspace has had a member.
// A workspace's first member is its owner (ADR-0049 decision 1). "First" is
// read from the memberships themselves, not the members-only marker: reopening
// clears the marker and keeps the members.
async function insertMembership(db: TenantScoped, workspaceId: string, profileId: string) {
  const now = Date.now()
  await inTenantTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('workspaceMemberships')
      .select('profileId')
      .where('workspaceId', '=', workspaceId)
      .limit(1)
      .executeTakeFirst()
    const role = existing === undefined ? 'owner' : 'member'
    await trx
      .insertInto('workspaceMemberships')
      .values({ workspaceId, profileId, createdAt: now, role })
      .onConflict((oc) => oc.columns(['workspaceId', 'profileId']).doNothing())
      .execute()
    await trx
      .insertInto('workspaceMembersOnly')
      .values({ workspaceId, since: now })
      .onConflict((oc) => oc.column('workspaceId').doNothing())
      .execute()
  })
}

// Deletes the membership row only — `workspaceMembersOnly` is never cleared
// here (see the file header).
async function deleteMembership(db: TenantScoped, workspaceId: string, profileId: string) {
  return db
    .deleteFrom('workspaceMemberships')
    .where('workspaceId', '=', workspaceId)
    .where('profileId', '=', profileId)
    .returning('profileId')
    .execute()
}

// `accountBindings` is keeper-wide, so this reads every passkey the account
// holds — the tenant's own pins (webauthn-credential-store.ts) are what say
// which of them this tenant accepts.
async function passkeysOf(db: TenantScoped, accountId: string) {
  const rows = await db
    .selectFrom('accountBindings')
    .select('subject')
    .where('accountId', '=', accountId)
    .where('authenticator', '=', PASSKEY_AUTHENTICATOR)
    .orderBy('createdAt', 'asc')
    .orderBy('subject', 'asc')
    .execute()
  return rows.map(({ subject }) => {
    const [origin, credentialId] = passkeySubjectSchema.parse(JSON.parse(subject))
    return { origin, credentialId }
  })
}

async function accountFor(db: TenantScoped, { authenticator, subject }: AuthenticatorBinding) {
  const row = await db
    .selectFrom('accountBindings')
    .select('accountId')
    .where('authenticator', '=', authenticator)
    .where('subject', '=', subject)
    .executeTakeFirst()
  return row?.accountId ?? null
}

// Whoever `binding` names here, deactivated or not.
async function userForBinding(db: TenantScoped, binding: AuthenticatorBinding) {
  const accountId = await accountFor(db, binding)
  return accountId === null ? null : loadProfileWhere(db, 'accountId', accountId)
}

function toProfile(
  row: z.infer<typeof memberProfileRowSchema>,
  credentials: z.infer<typeof profileCredentialSchema>[],
): MemberProfile {
  const { accountId: _accountId, ...user } = memberProfileRowSchema.parse(row)
  return memberProfileSchema.parse({ ...user, credentials })
}

// `db` may be a transaction: Kysely's Transaction is a Kysely.
async function loadProfileWhere(
  db: TenantScoped,
  column: 'id' | 'accountId',
  value: string,
): Promise<MemberProfile | null> {
  const row = await db
    .selectFrom('memberProfiles')
    .selectAll()
    .where(column, '=', value)
    .executeTakeFirst()
  if (row === undefined) return null
  return toProfile(row, await passkeysOf(db, row.accountId))
}

// Creates this tenant's user for an account (ADR-0045 decision 3: at most one
// per account per tenant, which the unique index also holds).
async function insertUser(db: TenantScoped, accountId: string, displayName: string) {
  const now = Date.now()
  const row = {
    id: generateDocumentId(),
    displayName,
    accountId,
    createdAt: now,
    updatedAt: now,
    deactivatedAt: null,
  }
  await db.insertInto('memberProfiles').values(row).execute()
  return row
}

// The store's methods that start from a binding: who it names, and minting
// that person's user here. Each goes binding -> account -> this tenant's user.
function bindingLookups(
  db: TenantScoped,
): Pick<MemberProfileStore, 'profileForBinding' | 'isDeactivated' | 'ensureProfile'> {
  return {
    async profileForBinding(binding) {
      const user = await userForBinding(db, binding)
      return user !== null && user.deactivatedAt === null ? user : null
    },

    async isDeactivated(binding) {
      const user = await userForBinding(db, binding)
      return user !== null && user.deactivatedAt !== null
    },

    async ensureProfile({ binding, displayName }) {
      return inTenantTransaction(db, async (trx) => {
        // A claimed credential names its account, and the account's user here
        // is the person; the display name given here does not rename them, and
        // nothing here ever merges two accounts — linking is an explicit
        // operation (ADR-0041 decision 7, ADR-0045 decision 4), not a side
        // effect of registering.
        const known = await accountFor(trx, binding)
        if (known !== null) {
          const user = await loadProfileWhere(trx, 'accountId', known)
          if (user !== null) return user
          return toProfile(await insertUser(trx, known, displayName), await passkeysOf(trx, known))
        }

        const accountId = generateDocumentId()
        const user = await insertUser(trx, accountId, displayName)
        const createdAt = user.createdAt
        await trx.insertInto('accounts').values({ id: accountId, createdAt }).execute()
        await trx
          .insertInto('accountBindings')
          .values({ ...binding, accountId, createdAt })
          .execute()
        return toProfile(user, await passkeysOf(trx, accountId))
      })
    },
  }
}

async function usersOf(db: TenantScoped) {
  const rows = await db
    .selectFrom('memberProfiles')
    .select(['id', 'displayName', 'deactivatedAt'])
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute()
  return rows.map(({ id, displayName, deactivatedAt }) => ({
    id,
    displayName,
    deactivated: deactivatedAt !== null,
  }))
}

// A user's role in a workspace, or null when they are not a member of it.
async function roleIn(db: TenantScoped, workspaceId: string, profileId: string) {
  const row = await db
    .selectFrom('workspaceMemberships')
    .select('role')
    .where('workspaceId', '=', workspaceId)
    .where('profileId', '=', profileId)
    .executeTakeFirst()
  return row?.role ?? null
}

const userById = (db: TenantScoped, profileId: string) => loadProfileWhere(db, 'id', profileId)

export function createMemberProfileStore(db: TenantScoped): MemberProfileStore {
  return {
    ...bindingLookups(db),

    async listMembers(workspaceId) {
      const rows = await db
        .selectFrom('workspaceMemberships')
        .innerJoin('memberProfiles', 'memberProfiles.id', 'workspaceMemberships.profileId')
        .select('memberProfiles.id')
        .where('workspaceMemberships.workspaceId', '=', workspaceId)
        .orderBy('memberProfiles.createdAt', 'asc')
        .orderBy('memberProfiles.id', 'asc')
        .execute()
      const profiles: MemberProfile[] = []
      for (const row of rows) {
        const profile = await loadProfileWhere(db, 'id', row.id)
        if (profile !== null) profiles.push(profile)
      }
      return profiles
    },

    listUsers: () => usersOf(db),

    passkeysOf: async (profileId) => (await userById(db, profileId))?.credentials ?? [],

    async addMember(workspaceId, profileId) {
      await insertMembership(db, workspaceId, profileId)
    },

    async revokeL1Membership(workspaceId, profileId) {
      const credentials = (await loadProfileWhere(db, 'id', profileId))?.credentials ?? []
      const deleted = await deleteMembership(db, workspaceId, profileId)
      return { removed: deleted.length > 0, credentials }
    },

    isWorkspaceMember: async (workspaceId, profileId) =>
      (await roleIn(db, workspaceId, profileId)) === null ? 'not-a-member' : 'member',

    membershipRole: (workspaceId, profileId) => roleIn(db, workspaceId, profileId),

    async reopenToOriginTrust(workspaceId) {
      const deleted = await db
        .deleteFrom('workspaceMembersOnly')
        .where('workspaceId', '=', workspaceId)
        .returning('workspaceId')
        .execute()
      return deleted.length > 0
    },

    async membersOnly(workspaceId) {
      const row = await db
        .selectFrom('workspaceMembersOnly')
        .select('workspaceId')
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst()
      return row !== undefined
    },
  }
}
