/**
 * ADR-0041's L1 subject: a MemberProfile is a PERSON, identified by the
 * passkey credentials the daemon has already pinned
 * (webauthn-credential-store.ts) — never by a paired browser origin. A
 * profile holds no key material; a credential id is only a public handle
 * (decision 1).
 *
 * `workspaceMemberships` is a plain DB row, deliberately OUTSIDE the
 * CRDT-synced workspace record (ADR-0019), so a sync merge cannot resurrect a
 * row this store deleted. Revocation (`revokeL1Membership`) is a plain
 * DELETE — no tombstone — because reversing one costs nothing (ADR-0042
 * decision 3).
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
import type { Database } from '../store/db/index.js'

const memberProfileRowSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict()

const profileCredentialRowSchema = z
  .object({
    credentialId: z.string().min(1),
    origin: z.string().min(1),
    profileId: z.string().min(1),
  })
  .strict()

const profileCredentialSchema = profileCredentialRowSchema.pick({
  origin: true,
  credentialId: true,
})

const memberProfileSchema = memberProfileRowSchema.extend({
  credentials: z.array(profileCredentialSchema),
})

type MemberProfile = z.infer<typeof memberProfileSchema>
type MembershipStatus = 'member' | 'not-a-member'

interface EnsureProfileInput {
  origin: string
  credentialId: string
  displayName: string
}

export interface MemberProfileStore {
  profileForCredential(origin: string, credentialId: string): Promise<MemberProfile | null>
  ensureProfile(input: EnsureProfileInput): Promise<MemberProfile>
  listMembers(workspaceId: string): Promise<MemberProfile[]>
  addMember(workspaceId: string, profileId: string): Promise<void>
  revokeL1Membership(
    workspaceId: string,
    profileId: string,
  ): Promise<{ removed: boolean; credentials: { origin: string; credentialId: string }[] }>
  isWorkspaceMember(workspaceId: string, profileId: string): Promise<MembershipStatus>
}

// `db` may be a transaction: Kysely's Transaction is a Kysely.
async function loadProfile(db: Database, profileId: string): Promise<MemberProfile | null> {
  const row = await db
    .selectFrom('memberProfiles')
    .selectAll()
    .where('id', '=', profileId)
    .executeTakeFirst()
  if (row === undefined) return null
  const credentials = await db
    .selectFrom('profileCredentials')
    .select(['origin', 'credentialId'])
    .where('profileId', '=', profileId)
    .execute()
  return memberProfileSchema.parse({ ...row, credentials })
}

export function createMemberProfileStore(db: Database): MemberProfileStore {
  return {
    async profileForCredential(origin, credentialId) {
      const pin = await db
        .selectFrom('profileCredentials')
        .select('profileId')
        .where('origin', '=', origin)
        .where('credentialId', '=', credentialId)
        .executeTakeFirst()
      if (pin === undefined) return null
      return loadProfile(db, pin.profileId)
    },

    async ensureProfile({ origin, credentialId, displayName }) {
      return db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('profileCredentials')
          .select('profileId')
          .where('origin', '=', origin)
          .where('credentialId', '=', credentialId)
          .executeTakeFirst()

        // A claimed credential names its person; the display name given here
        // does not rename them, and nothing here ever merges two profiles —
        // linking is an explicit operation (ADR-0041 decision 7), not a side
        // effect of registering.
        if (existing !== undefined) {
          const profile = await loadProfile(trx, existing.profileId)
          if (profile === null) {
            throw new Error(
              `profileCredentials row points at a missing profile: ${existing.profileId}`,
            )
          }
          return profile
        }

        const now = Date.now()
        const id = generateDocumentId()
        await trx
          .insertInto('memberProfiles')
          .values({ id, displayName, createdAt: now, updatedAt: now })
          .execute()
        await trx
          .insertInto('profileCredentials')
          .values({ credentialId, origin, profileId: id })
          .execute()

        return memberProfileSchema.parse({
          id,
          displayName,
          createdAt: now,
          updatedAt: now,
          credentials: [{ origin, credentialId }],
        })
      })
    },

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
        const profile = await loadProfile(db, row.id)
        if (profile !== null) profiles.push(profile)
      }
      return profiles
    },

    async addMember(workspaceId, profileId) {
      await db
        .insertInto('workspaceMemberships')
        .values({ workspaceId, profileId, createdAt: Date.now() })
        .onConflict((oc) => oc.columns(['workspaceId', 'profileId']).doNothing())
        .execute()
    },

    async revokeL1Membership(workspaceId, profileId) {
      const credentials = await db
        .selectFrom('profileCredentials')
        .select(['origin', 'credentialId'])
        .where('profileId', '=', profileId)
        .execute()
      const deleted = await db
        .deleteFrom('workspaceMemberships')
        .where('workspaceId', '=', workspaceId)
        .where('profileId', '=', profileId)
        .returning('profileId')
        .execute()
      return { removed: deleted.length > 0, credentials }
    },

    async isWorkspaceMember(workspaceId, profileId) {
      const row = await db
        .selectFrom('workspaceMemberships')
        .select('profileId')
        .where('workspaceId', '=', workspaceId)
        .where('profileId', '=', profileId)
        .executeTakeFirst()
      return row === undefined ? 'not-a-member' : 'member'
    },
  }
}
