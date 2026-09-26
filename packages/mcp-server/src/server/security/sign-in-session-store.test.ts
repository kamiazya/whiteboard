import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createSignInSessionStore, type SignInSessionStore } from './sign-in-session-store.js'

const T0 = 1_800_000_000_000
const person = { authenticator: 'oidc:https://sso.corp.example', subject: 'ada-1' }

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let sessions: SignInSessionStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-sign-in-sessions-'))
  handle = await createIsolatedDb({ dataDir: root })
  sessions = createSignInSessionStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('sign-in sessions', () => {
  it('resolves a live session to the person, and stores only the token hash', async () => {
    const token = await sessions.create(person, T0, 1000)
    expect(await sessions.resolve(token, T0 + 999)).toEqual(person)
    const rows = await handle.rawDb.selectFrom('signInSessions').selectAll().execute()
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('does not resolve once expired, nor after it is ended', async () => {
    const token = await sessions.create(person, T0, 1000)
    expect(await sessions.resolve(token, T0 + 1000)).toBeNull()
    const second = await sessions.create(person, T0, 1000)
    expect(await sessions.end(second)).toBe(true)
    expect(await sessions.resolve(second, T0 + 1)).toBeNull()
  })

  // Nothing else ever removes an expired session, so opening one is where the
  // table sheds them; otherwise it grows with every sign-in forever.
  it('deletes expired sessions when a new one is opened', async () => {
    await sessions.create(person, T0, 1000)
    await sessions.create(person, T0 + 5000, 1000)
    const rows = await handle.rawDb.selectFrom('signInSessions').selectAll().execute()
    expect(rows).toHaveLength(1)
  })

  // ADR-0051 decision 5: administration asks how recently the provider
  // authenticated the person, which the session carries from its sign-in.
  it('opens to the person and when the provider authenticated them, or null when it did not say', async () => {
    const said = await sessions.create(person, T0, 1000, T0 - 30)
    const silent = await sessions.create(person, T0, 1000)
    expect(await sessions.open(said, T0 + 1)).toEqual({ person, authenticatedAt: T0 - 30 })
    expect(await sessions.open(silent, T0 + 1)).toEqual({ person, authenticatedAt: null })
    expect(await sessions.open(said, T0 + 1000)).toBeNull()
  })

  it('belongs to the tenant it was opened in', async () => {
    const token = await sessions.create(person, T0, 1000)
    const other = createSignInSessionStore(tenantDatabase(handle.rawDb, 'tenant-two'))
    expect(await other.resolve(token, T0 + 1)).toBeNull()
  })
})
