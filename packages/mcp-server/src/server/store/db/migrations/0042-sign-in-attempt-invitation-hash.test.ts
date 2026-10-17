/**
 * An attempt in flight keeps the hash of the invitation it carries, never
 * the token. Rows that predate the migration carry the token itself, and
 * an attempt lives minutes, so one begun before an upgrade must still
 * redeem the link after it: the token is rehashed in place.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openMigrationHarness } from '../test-helpers.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0042 = '0041-drop-version-branch-name'

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-0042-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

it('replaces an in-flight attempt’s invitation token with its hash', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0042)
  await sql`
    insert into signInAttempts
      (state, browserBindingHash, providerId, nonce, codeVerifier, invitationToken,
       returnTo, expiresAt, tenantId)
    values
      ('s-invited', 'b1', 'corp', 'n1', 'v1', 'raw-token', '/', 10, 't1'),
      ('s-plain', 'b2', 'corp', 'n2', 'v2', null, '/w', 20, 't1')
  `.execute(db)
  await migrateToHead()
  const columns = await sql<{ name: string }>`
    select name from pragma_table_info('signInAttempts')
  `.execute(db)
  expect(columns.rows.map((r) => r.name)).not.toContain('invitationToken')
  const rows = await sql<{ state: string; invitationTokenHash: string | null }>`
    select state, invitationTokenHash from signInAttempts order by state
  `.execute(db)
  // Computed here with node:crypto, not the keeper's helper, so the two
  // cannot agree by sharing a mistake.
  const expected = createHash('sha256').update('raw-token', 'utf8').digest('hex')
  expect(rows.rows).toEqual([
    { state: 's-invited', invitationTokenHash: expected },
    { state: 's-plain', invitationTokenHash: null },
  ])
  await db.destroy()
})
