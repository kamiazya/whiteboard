/**
 * ADR-0049 decision 4 from the operator's side: the machine that holds the
 * data can deactivate a user and reverse it, the same trust `grant-admin`
 * rests on. Administrators do the same from inside the product.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { createIsolatedDb } from '../server/store/db/test-helpers.js'
import { deactivateUser, runServerDeactivateUser } from './server-deactivate-user.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

const binding = { authenticator: 'oidc:test', subject: 'ada-1' }
const members = () => createMemberProfileStore(handle.db)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-deactivate-user-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('deactivateUser', () => {
  it('deactivates a user named by display name, and reactivates them', async () => {
    const ada = await members().ensureProfile({ binding, displayName: 'Ada' })
    expect(await deactivateUser(handle.db, { user: 'Ada', reactivate: false, now: 1 })).toEqual({
      kind: 'ok',
      user: { id: ada.id, displayName: 'Ada' },
      deactivated: true,
      changed: true,
    })
    expect(await members().isDeactivated(binding)).toBe(true)

    expect(
      await deactivateUser(handle.db, { user: ada.id, reactivate: true, now: 2 }),
    ).toMatchObject({ kind: 'ok', deactivated: false, changed: true })
    expect(await members().isDeactivated(binding)).toBe(false)
  })

  it('says when there was nothing to change', async () => {
    await members().ensureProfile({ binding, displayName: 'Ada' })
    expect(
      await deactivateUser(handle.db, { user: 'Ada', reactivate: true, now: 1 }),
    ).toMatchObject({ kind: 'ok', deactivated: false, changed: false })
  })

  // A deactivated user must stay nameable, or they could never be reactivated.
  it('finds a deactivated user by name to reactivate them', async () => {
    await members().ensureProfile({ binding, displayName: 'Ada' })
    await deactivateUser(handle.db, { user: 'Ada', reactivate: false, now: 1 })
    expect(
      await deactivateUser(handle.db, { user: 'Ada', reactivate: true, now: 2 }),
    ).toMatchObject({ kind: 'ok', changed: true })
  })
})

describe('runServerDeactivateUser', () => {
  const run = async (args: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }
    const code = await runServerDeactivateUser([...args, `--data-dir=${root}`], io)
    return { code, stdout: out.join(''), stderr: err.join('') }
  }

  it('deactivates and prints what it did as one JSON line', async () => {
    await members().ensureProfile({ binding, displayName: 'Ada' })
    const res = await run(['--json', '--user=Ada'])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ kind: 'ok', deactivated: true })
  })

  it('exits 1 when nobody matches', async () => {
    expect((await run(['--json', '--user=Nobody'])).code).toBe(1)
  })

  it('exits 64 without --user', async () => {
    expect((await run(['--json'])).code).toBe(64)
  })
})
