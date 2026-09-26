/**
 * ADR-0046 decision 10: the first member of a workspace that already exists
 * is granted by the operator, on the machine that holds the data directory.
 * The person names themselves by signing in; the operator names them by
 * their user id or their display name here, and an unknown or ambiguous
 * name is refused with the candidates rather than guessed.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createMemberProfileStore,
  type MemberProfileStore,
} from '../server/security/member-profile-store.js'
import { createUserDeactivation } from '../server/security/user-deactivation.js'
import { createIsolatedDb } from '../server/store/db/test-helpers.js'
import { upsertWorkspaceRow } from '../server/store/db/upsert-workspace.js'
import { grantMember, runServerGrantMember } from './server-grant-member.js'

const WS = 'ws-plans'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore

async function userNamed(displayName: string, subject: string) {
  return members.ensureProfile({
    binding: { authenticator: 'oidc:test', subject },
    displayName,
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-grant-member-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  await upsertWorkspaceRow(handle.db, WS)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('grantMember', () => {
  it('makes a user named by id a member, closing the workspace to everyone else', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const outcome = await grantMember(handle.db, { workspaceId: WS, user: ada.id })
    expect(outcome).toEqual({
      kind: 'ok',
      workspaceId: WS,
      user: { id: ada.id, displayName: 'Ada' },
    })
    expect(await members.isWorkspaceMember(WS, ada.id)).toBe('member')
    expect(await members.membersOnly(WS)).toBe(true)
  })

  // What an operator sees is the address in the URL, which is the segment.
  it('finds the workspace by its segment, the handle in its URL', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-01HX', { segment: 'plans' })
    const ada = await userNamed('Ada', 'ada-1')
    const outcome = await grantMember(handle.db, { workspaceId: 'plans', user: ada.id })
    expect(outcome.kind === 'ok' && outcome.workspaceId).toBe('ws-01HX')
    expect(await members.isWorkspaceMember('ws-01HX', ada.id)).toBe('member')
  })

  it('finds a user by their exact display name', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    await userNamed('Bob', 'bob-1')
    const outcome = await grantMember(handle.db, { workspaceId: WS, user: 'Ada' })
    expect(outcome.kind === 'ok' && outcome.user.id).toBe(ada.id)
  })

  it('refuses a name two users share, listing both', async () => {
    const one = await userNamed('Ada', 'ada-1')
    const two = await userNamed('Ada', 'ada-2')
    const outcome = await grantMember(handle.db, { workspaceId: WS, user: 'Ada' })
    expect(outcome.kind).toBe('ambiguous-user')
    expect(outcome.kind === 'ambiguous-user' && outcome.users.map((u) => u.id).sort()).toEqual(
      [one.id, two.id].sort(),
    )
    expect(await members.membersOnly(WS)).toBe(false)
  })

  it('refuses a user nobody has signed in as, listing who has', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const outcome = await grantMember(handle.db, { workspaceId: WS, user: 'Grace' })
    expect(outcome).toEqual({
      kind: 'unknown-user',
      users: [{ id: ada.id, displayName: 'Ada' }],
    })
  })

  // ADR-0049: a workspace whose owners are all deactivated is recovered
  // with this command, so the person it names comes out an OWNER — a member
  // could not manage the people of the workspace it was meant to recover.
  it('recovers a workspace whose every owner is deactivated, naming a newcomer', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const bob = await userNamed('Bob', 'bob-1')
    await members.addMember(WS, ada.id)
    await createUserDeactivation(handle.db).deactivate(ada.id, Date.now())
    await grantMember(handle.db, { workspaceId: WS, user: bob.id })
    expect(await members.membershipRole(WS, bob.id)).toBe('owner')
  })

  it('recovers it by promoting someone who is already a member', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const bob = await userNamed('Bob', 'bob-1')
    await members.addMember(WS, ada.id)
    await members.addMember(WS, bob.id)
    await createUserDeactivation(handle.db).deactivate(ada.id, Date.now())
    await grantMember(handle.db, { workspaceId: WS, user: bob.id })
    expect(await members.membershipRole(WS, bob.id)).toBe('owner')
  })

  it('adds a plain member while an active owner remains', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const bob = await userNamed('Bob', 'bob-1')
    await members.addMember(WS, ada.id)
    await grantMember(handle.db, { workspaceId: WS, user: bob.id })
    expect(await members.membershipRole(WS, bob.id)).toBe('member')
  })

  it('refuses a workspace this keeper does not hold', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const outcome = await grantMember(handle.db, { workspaceId: 'ws-nowhere', user: ada.id })
    expect(outcome).toEqual({ kind: 'unknown-workspace', workspaceId: 'ws-nowhere' })
  })
})

describe('whiteboard server grant-member', () => {
  function run(args: readonly string[]) {
    const out: string[] = []
    const err: string[] = []
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }
    return runServerGrantMember(args, io).then((code) => ({
      code,
      stdout: out.join(''),
      stderr: err.join(''),
    }))
  }

  it('grants and prints what it did as one JSON line', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const res = await run(['--json', `--workspace=${WS}`, '--user=Ada', `--data-dir=${root}`])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({
      kind: 'ok',
      workspaceId: WS,
      user: { id: ada.id, displayName: 'Ada' },
    })
  })

  it('exits 1 and names the fix when nobody matches', async () => {
    const res = await run(['--json', `--workspace=${WS}`, '--user=Grace', `--data-dir=${root}`])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('whiteboard server add-user')
  })

  it('exits 64 without --workspace', async () => {
    const res = await run(['--json', '--user=Ada'])
    expect(res.code).toBe(64)
    expect(res.stderr).toContain('--workspace=<id|segment> is required')
  })
})
