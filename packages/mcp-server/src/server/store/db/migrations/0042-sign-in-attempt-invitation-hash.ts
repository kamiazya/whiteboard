import { createHash } from 'node:crypto'
import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// The invitation store keeps only a link token's hash (0033), but an attempt
// in flight held the token itself for its ten minutes — the one place a live
// link could be read back out of the database. The attempt now keeps the
// hash, which is all redemption looks the invitation up by.
//
// An attempt begun before the upgrade must still redeem its link after it,
// so the tokens are rehashed in place rather than dropped. The digest is
// computed here, not through the keeper's helper, so a later change to that
// helper cannot change what this migration did.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('signInAttempts')
      .renameColumn('invitationToken', 'invitationTokenHash')
      .execute()
    const carried = await sql<{ state: string; invitationTokenHash: string }>`
      select state, invitationTokenHash from signInAttempts where invitationTokenHash is not null
    `.execute(db)
    for (const { state, invitationTokenHash: token } of carried.rows) {
      const hash = createHash('sha256').update(token, 'utf8').digest('hex')
      await sql`
        update signInAttempts set invitationTokenHash = ${hash} where state = ${state}
      `.execute(db)
    }
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // A hash cannot be turned back into its token, so an attempt carrying an
    // invitation cannot be finished under the old shape; it is dropped, and
    // the person begins again from the link.
    await sql`delete from signInAttempts where invitationTokenHash is not null`.execute(db)
    await db.schema
      .alterTable('signInAttempts')
      .renameColumn('invitationTokenHash', 'invitationToken')
      .execute()
  },
}
