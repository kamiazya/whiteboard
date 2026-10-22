/**
 * ADR-0046 decision 10: the first member of a workspace that already exists
 * is granted by the operator, on the machine that holds the data directory.
 * The person names themselves by signing in; the operator names them by
 * their user id or by provider and subject — never by display name, which
 * the person's provider chose — and a reference reaching nobody is refused
 * with the candidates.
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
import { providerAuthenticator, signInConfigSchema } from '../server/security/sign-in-config.js'
import { createUserDeactivation } from '../server/security/user-deactivation.js'
import { createIsolatedDb, fillNamespace } from '../server/store/db/test-helpers.js'
import { upsertWorkspaceRow } from '../server/store/db/upsert-workspace.js'
import { grantMemberOutputSchema } from './operator-json.js'
import { grantMember, runServerGrantMember } from './server-grant-member.js'

// A bearer-only provider, so the declaration needs no client secret.
const CORP = {
  id: 'corp',
  kind: 'oidc',
  issuer: 'https://sso.corp.example',
  admission: { bearerClients: ['ops'] },
} as const

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
    const outcome = await grantMember(handle.db, {
      workspaceId: WS,
      user: { kind: 'id', id: ada.id },
    })
    expect(outcome).toEqual({
      kind: 'ok',
      workspaceId: WS,
      user: {
        id: ada.id,
        displayName: 'Ada',
        bindings: [{ provider: null, authenticator: 'oidc:test', subject: 'ada-1' }],
      },
    })
    expect(await members.isWorkspaceMember(WS, ada.id)).toBe('member')
  })

  // What an operator sees is the address in the URL, which is the segment.
  it('finds the workspace by its segment, the handle in its URL', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-01HX', { segment: 'plans' })
    const ada = await userNamed('Ada', 'ada-1')
    const outcome = await grantMember(handle.db, {
      workspaceId: 'plans',
      user: { kind: 'id', id: ada.id },
    })
    expect(outcome.kind === 'ok' && outcome.workspaceId).toBe('ws-01HX')
    expect(await members.isWorkspaceMember('ws-01HX', ada.id)).toBe('member')
  })

  // ADR-0053: one segment may sit in several namespaces, and the operator
  // has none of their own to mean by a bare one.
  it('finds a segment held in a namespace only when the address names it', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-ada', { namespace: 'ada', segment: 'plans' })
    await upsertWorkspaceRow(handle.db, 'ws-bob', { namespace: 'bob', segment: 'plans' })
    const ada = await userNamed('Ada', 'ada-1')

    const bare = await grantMember(handle.db, {
      workspaceId: 'plans',
      user: { kind: 'id', id: ada.id },
    })
    const qualified = await grantMember(handle.db, {
      workspaceId: 'bob/plans',
      user: { kind: 'id', id: ada.id },
    })

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

    const outcome = await grantMember(handle.db, {
      workspaceId: 'plans',
      user: { kind: 'id', id: ada.id },
    })

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

    const outcome = await grantMember(handle.db, {
      workspaceId: WS,
      user: { kind: 'id', id: ada.id },
    })

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

    await grantMember(handle.db, { workspaceId: id, user: { kind: 'id', id: bob.id } })

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

    await grantMember(handle.db, { workspaceId: 'ws-bob', user: { kind: 'id', id: ada.id } })

    const row = await handle.db
      .selectFrom('workspaces')
      .select(['namespace', 'segment'])
      .where('id', '=', 'ws-bob')
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ namespace: 'bob', segment: 'plans' })
  })

  it('finds a user by provider and subject, telling two of one name apart', async () => {
    const one = await members.ensureProfile({
      binding: { authenticator: providerAuthenticator(CORP), subject: 'ada-1' },
      displayName: 'Ada',
    })
    const two = await members.ensureProfile({
      binding: { authenticator: providerAuthenticator(CORP), subject: 'ada-2' },
      displayName: 'Ada',
    })
    const outcome = await grantMember(handle.db, {
      workspaceId: WS,
      user: { kind: 'binding', provider: 'corp', subject: 'ada-2' },
      providers: signInConfigSchema.parse({ providers: [CORP] }).providers,
    })
    expect(outcome.kind === 'ok' && outcome.user.id).toBe(two.id)
    expect(await members.isWorkspaceMember(WS, one.id)).toBe('not-a-member')
  })

  it('refuses a subject nobody has signed in as, listing who has', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const outcome = await grantMember(handle.db, {
      workspaceId: WS,
      user: { kind: 'id', id: 'Grace' },
    })
    expect(outcome).toEqual({
      kind: 'unknown-user',
      users: [
        {
          id: ada.id,
          displayName: 'Ada',
          bindings: [{ provider: null, authenticator: 'oidc:test', subject: 'ada-1' }],
        },
      ],
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
    await grantMember(handle.db, { workspaceId: WS, user: { kind: 'id', id: bob.id } })
    expect(await members.membershipRole(WS, bob.id)).toBe('owner')
  })

  it('recovers it by promoting someone who is already a member', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const bob = await userNamed('Bob', 'bob-1')
    await members.addMember(WS, ada.id)
    await members.addMember(WS, bob.id)
    await createUserDeactivation(handle.db).deactivate(ada.id, Date.now())
    await grantMember(handle.db, { workspaceId: WS, user: { kind: 'id', id: bob.id } })
    expect(await members.membershipRole(WS, bob.id)).toBe('owner')
  })

  it('adds a plain member while an active owner remains', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const bob = await userNamed('Bob', 'bob-1')
    await members.addMember(WS, ada.id)
    await grantMember(handle.db, { workspaceId: WS, user: { kind: 'id', id: bob.id } })
    expect(await members.membershipRole(WS, bob.id)).toBe('member')
  })

  it('refuses a workspace this keeper does not hold', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    const outcome = await grantMember(handle.db, {
      workspaceId: 'ws-nowhere',
      user: { kind: 'id', id: ada.id },
    })
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
    const res = await run(['--json', `--workspace=${WS}`, `--user=${ada.id}`, `--data-dir=${root}`])
    expect(res.code).toBe(0)
    expect(grantMemberOutputSchema.parse(JSON.parse(res.stdout))).toEqual({
      schemaVersion: 1,
      kind: 'ok',
      workspaceId: WS,
      user: {
        id: ada.id,
        displayName: 'Ada',
        bindings: [{ provider: null, authenticator: 'oidc:test', subject: 'ada-1' }],
      },
    })
  })

  it('exits 1 and names the fix when nobody matches', async () => {
    const res = await run(['--json', `--workspace=${WS}`, '--user=Grace', `--data-dir=${root}`])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('whiteboard server add-user')
  })

  // A display name is whatever the person's provider claims at first sign-in,
  // so whoever signs in as "Alice" first would be the one granted.
  it('refuses a display name as --user, granting nobody', async () => {
    const attacker = await userNamed('Alice', 'attacker')
    const res = await run(['--json', `--workspace=${WS}`, '--user=Alice', `--data-dir=${root}`])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stdout)).toMatchObject({ kind: 'unknown-user' })
    expect(await members.isWorkspaceMember(WS, attacker.id)).toBe('not-a-member')
  })

  it('exits 64 without --workspace', async () => {
    const res = await run(['--json', '--user=Ada'])
    expect(res.code).toBe(64)
    expect(res.stderr).toContain('--workspace=<id|handle/segment|segment> is required')
  })
})
