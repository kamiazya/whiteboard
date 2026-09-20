import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0041's L1 subject: a MemberProfile is a PERSON, identified by the
// passkey credentials the daemon has already pinned (webauthn-credential-
// store.ts), never by a paired browser origin. A profile holds no key
// material (decision 1) — `profileCredentials` stores only the credential's
// public handle, the same (credentialId, origin) pair the pin itself is
// keyed on.
//
// `workspaceMemberships` is a ROW TABLE, not a field on the CRDT-synced
// workspace record: ADR-0019 keeps identity metadata out of the mergeable
// record, and a sync merge could otherwise resurrect a row this table
// deleted. Revocation is a plain DELETE (ADR-0042 decision 3: reversing one
// costs nothing, so there is no tombstone to maintain).
//
// No foreign keys — house style since 0016/0017, delete paths sweep rows
// explicitly. No seeded row of any kind: fail-closed here is achieved by
// SCOPE OF CONSULTATION (callers never consult membership for `anonymous`/
// `daemon-token` grants), not by a permissive default, so an empty table
// correctly means nobody is a member. See member-profile-store.ts for why
// that diverges from the JSON-file stores' fail-open posture.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('memberProfiles')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('displayName', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute()
    await db.schema
      .createTable('profileCredentials')
      .addColumn('credentialId', 'text', (col) => col.notNull())
      .addColumn('origin', 'text', (col) => col.notNull())
      .addColumn('profileId', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('profileCredentials_pk', ['credentialId', 'origin'])
      .execute()
    await db.schema
      .createTable('workspaceMemberships')
      .addColumn('workspaceId', 'text', (col) => col.notNull())
      .addColumn('profileId', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('workspaceMemberships_pk', ['workspaceId', 'profileId'])
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('workspaceMemberships').execute()
    await db.schema.dropTable('profileCredentials').execute()
    await db.schema.dropTable('memberProfiles').execute()
  },
}
