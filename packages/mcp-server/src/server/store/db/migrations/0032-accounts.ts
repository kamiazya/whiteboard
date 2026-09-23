import { generateDocumentId } from '@kamiazya/whiteboard-model'
import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0045 decision 5: an ACCOUNT is the keeper-wide login identity, a USER
// (a `memberProfiles` row) is who that account is inside one tenant. Each
// existing profile becomes one account plus one user, and each credential it
// held becomes a binding on the account.
//
// `accounts` and `accountBindings` are KEEPER-WIDE — no tenantId — because an
// account belongs to no tenant. The link back to a tenant is the user row's
// `accountId`, kept inside the tenant (decision 13), so nothing keeper-wide
// can list the tenants an account is in.
//
// A binding is (authenticator, subject): which authenticator vouched and what
// it vouched for (decision 15). The passkey authenticator's subject is the
// pin's own identity, `[origin, credentialId]` as JSON — the same claim
// `profileCredentials` keyed on, so a credential under two origins stays two
// claims, exactly as before.
//
// ponytail: `accountId` is nullable at the column level because SQLite's ADD
// COLUMN cannot add NOT NULL without a default; every row is filled here and
// every insert the store makes carries one. Rebuild the table if a NULL ever
// turns up.
//
// FROZEN like every migration: the authenticator name and subject encoding
// are spelled here, not imported.
const PASSKEY = 'passkey'

interface MigrationSchema {
  memberProfiles: { id: string; tenantId: string; accountId: string | null }
  profileCredentials: { credentialId: string; origin: string; profileId: string; tenantId: string }
  accounts: { id: string; createdAt: number }
  accountBindings: { authenticator: string; subject: string; accountId: string; createdAt: number }
}

export const migration: Migration = {
  async up(raw: Kysely<unknown>): Promise<void> {
    const db = raw as Kysely<MigrationSchema>
    await db.schema
      .createTable('accounts')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .execute()
    await db.schema
      .createTable('accountBindings')
      .addColumn('authenticator', 'text', (col) => col.notNull())
      .addColumn('subject', 'text', (col) => col.notNull())
      .addColumn('accountId', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('accountBindings_pk', ['authenticator', 'subject'])
      .execute()
    await db.schema
      .createIndex('accountBindings_accountId')
      .on('accountBindings')
      .column('accountId')
      .execute()
    await db.schema.alterTable('memberProfiles').addColumn('accountId', 'text').execute()

    const now = Date.now()
    const profiles = await db.selectFrom('memberProfiles').select('id').execute()
    const accountOf = new Map<string, string>()
    for (const { id } of profiles) {
      const accountId = generateDocumentId()
      accountOf.set(id, accountId)
      await db.insertInto('accounts').values({ id: accountId, createdAt: now }).execute()
      await db.updateTable('memberProfiles').set({ accountId }).where('id', '=', id).execute()
    }
    const credentials = await db.selectFrom('profileCredentials').selectAll().execute()
    for (const { credentialId, origin, profileId } of credentials) {
      const accountId = accountOf.get(profileId)
      // A credential whose profile is gone named nobody; the store already
      // refused to resolve one.
      if (accountId === undefined) continue
      await db
        .insertInto('accountBindings')
        .values({
          authenticator: PASSKEY,
          subject: JSON.stringify([origin, credentialId]),
          accountId,
          createdAt: now,
        })
        .execute()
    }
    // Decision 3: at most one user per account per tenant.
    await db.schema
      .createIndex('memberProfiles_tenant_account')
      .on('memberProfiles')
      .columns(['tenantId', 'accountId'])
      .unique()
      .execute()
    await db.schema.dropTable('profileCredentials').execute()
  },

  async down(raw: Kysely<unknown>): Promise<void> {
    const db = raw as Kysely<MigrationSchema>
    await db.schema
      .createTable('profileCredentials')
      .addColumn('credentialId', 'text', (col) => col.notNull())
      .addColumn('origin', 'text', (col) => col.notNull())
      .addColumn('profileId', 'text', (col) => col.notNull())
      .addColumn('tenantId', 'text', (col) => col.notNull().defaultTo('self-host'))
      .addPrimaryKeyConstraint('profileCredentials_pk', ['credentialId', 'origin'])
      .execute()
    await db.schema
      .createIndex('profileCredentials_tenantId')
      .on('profileCredentials')
      .column('tenantId')
      .execute()
    const rows = await db
      .selectFrom('accountBindings')
      .innerJoin('memberProfiles', 'memberProfiles.accountId', 'accountBindings.accountId')
      .select(['accountBindings.subject', 'memberProfiles.id', 'memberProfiles.tenantId'])
      .where('accountBindings.authenticator', '=', PASSKEY)
      .execute()
    for (const { subject, id, tenantId } of rows) {
      const [origin, credentialId] = JSON.parse(subject) as [string, string]
      await db
        .insertInto('profileCredentials')
        .values({ credentialId, origin, profileId: id, tenantId })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    await db.schema.dropIndex('memberProfiles_tenant_account').execute()
    await db.schema.alterTable('memberProfiles').dropColumn('accountId').execute()
    await db.schema.dropTable('accountBindings').execute()
    await db.schema.dropTable('accounts').execute()
  },
}
