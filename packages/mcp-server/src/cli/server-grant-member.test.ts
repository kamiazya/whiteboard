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
import { NAMESPACE_MAX_WORKSPACES } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createMemberProfileStore,
  type MemberProfileStore,
} from '../server/security/member-profile-store.js'
import { createUserDeactivation } from '../server/security/user-deactivation.js'
import { createIsolatedDb, fillNamespace } from '../server/store/db/test-helpers.js'
import { upsertWorkspaceRow } from '../server/store/db/upsert-workspace.js'
import { grantMemberOutputSchema } from './operator-json.js'
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
  })

  // What an operator sees is the address in the URL, which is the segment.
  it('finds the workspace by its segment, the handle in its URL', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-01HX', { segment: 'plans' })
    const ada = await userNamed('Ada', 'ada-1')
    const outcome = await grantMember(handle.db, { workspaceId: 'plans', user: ada.id })
    expect(outcome.kind === 'ok' && outcome.workspaceId).toBe('ws-01HX')
    expect(await members.isWorkspaceMember('ws-01HX', ada.id)).toBe('member')
  })

  // ADR-0053: one segment may sit in several namespaces, and the operator
  // has none of their own to mean by a bare one.
  it('finds a segment held in a namespace only when the address names it', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-ada', { namespace: 'ada', segment: 'plans' })
    await upsertWorkspaceRow(handle.db, 'ws-bob', { namespace: 'bob', segment: 'plans' })
    const ada = await userNamed('Ada', 'ada-1')

    const bare = await grantMember(handle.db, { workspaceId: 'plans', user: ada.id })
    const qualified = await grantMember(handle.db, { workspaceId: 'bob/plans', user: ada.id })

    expect(bare.kind).toBe('unknown-workspace')
    expect(qualified.kind === 'ok' && qualified.workspaceId).toBe('ws-bob')
  })

  // A workspace a single-person keeper made, restored onto server mode, sits
  // in `me`, which no server-mode user holds: its first owner's own bare
  // segment has to reach it once the operator grants them.
  it("moves a workspace no namespace holds into its first owner's", async () => {
    await upsertWorkspaceRow(handle.db, 'ws-restored', { namespace: 'me', segment: 'plans' })
    await upsertWorkspaceRow(handle.db, 'ws-ada-own', { namespace: 'ada', segment: 'plans' })
    const ada = await userNamed('Ada', 'ada-1')

    const outcome = await grantMember(handle.db, { workspaceId: 'plans', user: ada.id })

    expect(outcome.kind === 'ok' && outcome.workspaceId).toBe('ws-restored')
    const row = await handle.db
      .selectFrom('workspaces')
      .select(['namespace', 'segment'])
      .where('id', '=', 'ws-restored')
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ namespace: ada.handle, segment: 'plans-2' })
  })

  // A grant is not refused for the ceiling: the workspace waits in `me`,
  // reachable by its id, rather than pushing its owner past it.
  it('leaves a workspace in `me` while its owner is at the workspace ceiling', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    await fillNamespace(handle.db, ada.handle, NAMESPACE_MAX_WORKSPACES)

    const outcome = await grantMember(handle.db, { workspaceId: WS, user: ada.id })

    expect(outcome.kind).toBe('ok')
    expect(await members.membershipRole(WS, ada.id)).toBe('owner')
    const row = await handle.db
      .selectFrom('workspaces')
      .select('namespace')
      .where('id', '=', WS)
      .executeTakeFirstOrThrow()
    expect(row.namespace).toBe('me')
  })

  // A workspace parked in `me` with people still in it carries a segment
  // somebody else chose; kept bare, the recipient's own `journal` would reach
  // a workspace those people read.
  it("tails the segment of a workspace others are in as it moves to the owner's", async () => {
    const id = '01HXPARKED00000000000ZQ7W4'
    await upsertWorkspaceRow(handle.db, id, { namespace: 'me', segment: 'journal' })
    const mallory = await userNamed('Mallory', 'mallory-1')
    await handle.db
      .insertInto('workspaceMemberships')
      .values({ workspaceId: id, profileId: mallory.id, createdAt: Date.now(), role: 'member' })
      .execute()
    const bob = await userNamed('Bob', 'bob-1')

    await grantMember(handle.db, { workspaceId: id, user: bob.id })

    const row = await handle.db
      .selectFrom('workspaces')
      .select(['namespace', 'segment'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(await members.membershipRole(id, bob.id)).toBe('owner')
    expect(row).toEqual({ namespace: bob.handle, segment: 'journal-000zq7w4' })
  })

  it('moves only a workspace held in `me`, never one another namespace holds', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-bob', { namespace: 'bob', segment: 'plans' })
    const ada = await userNamed('Ada', 'ada-1')

    await grantMember(handle.db, { workspaceId: 'ws-bob', user: ada.id })

    const row = await handle.db
      .selectFrom('workspaces')
      .select(['namespace', 'segment'])
      .where('id', '=', 'ws-bob')
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ namespace: 'bob', segment: 'plans' })
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
    expect(await members.isWorkspaceMember(WS, one.id)).toBe('not-a-member')
    expect(await members.isWorkspaceMember(WS, two.id)).toBe('not-a-member')
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
    expect(grantMemberOutputSchema.parse(JSON.parse(res.stdout))).toEqual({
      schemaVersion: 1,
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
    expect(res.stderr).toContain('--workspace=<id|handle/segment|segment> is required')
  })
})
