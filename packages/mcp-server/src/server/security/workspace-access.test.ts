/**
 * Membership (ADR-0041 L1, ADR-0042 d3-d4, user decision 2026-09-21)
 * gates ONLINE access. `workspaceAccess` is the ONE decision — every
 * membership-gated surface (the registry-driven routes and SSE) is meant to call this rather than keep its
 * own copy, which is exactly the shape that let an L1 revoke bite only the
 * OFFLINE replica key while the same removed person kept reading and
 * writing live through every other route.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import type { ResolvedGrant } from './credential-resolver.js'
import {
  createMemberProfileStore,
  type MemberProfileStore,
  passkeyBinding,
} from './member-profile-store.js'
import { membershipRefusal, OPERATOR_ISSUED_KINDS, workspaceAccess } from './workspace-access.js'
import { createWorkspaceRoles, type WorkspaceRoles } from './workspace-roles.js'

const WS = 'ws-1'
const ORIGIN = 'https://a.example'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let roles: WorkspaceRoles

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-workspace-access-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  roles = createWorkspaceRoles(handle.db, { ownedByTheMachine: true })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

function grantOf(
  kind: ResolvedGrant['kind'],
  passkey?: { origin: string; credentialId: string },
): ResolvedGrant {
  return {
    kind,
    scopes: [],
    ...(passkey !== undefined
      ? { person: passkeyBinding(passkey.origin, passkey.credentialId) }
      : {}),
  }
}

const UNBOUND_SESSION = grantOf('signed-in')

// Hardcoded independently of OPERATOR_ISSUED_KINDS: the table below must
// notice a kind DROPPED from that export, and iterating the export itself
// cannot — a shrunk array is still self-consistent with a shrunk test loop.
const EXPECTED_OPERATOR_ISSUED_KINDS = [
  'anonymous',
  'daemon-token',
  'macaroon',
] as const satisfies readonly ResolvedGrant['kind'][]

describe('workspaceAccess — operator-issued kinds (arm 1)', () => {
  it('OPERATOR_ISSUED_KINDS is exactly the three operator-issued kinds', () => {
    expect([...OPERATOR_ISSUED_KINDS].sort()).toEqual([...EXPECTED_OPERATOR_ISSUED_KINDS].sort())
  })

  it.for(
    EXPECTED_OPERATOR_ISSUED_KINDS,
  )('admits %s even on a workspace with a member, unbound', async (kind) => {
    const profile = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-1'),
      displayName: 'Ada',
    })
    await members.addMember(WS, profile.id)
    expect(await workspaceAccess(grantOf(kind), WS, members)).toBe('admitted')
  })
})

describe('workspaceAccess — member-less workspace', () => {
  it('asks an unbound session for a person when the workspace has zero members', async () => {
    expect(await workspaceAccess(UNBOUND_SESSION, WS, members)).toBe('requires_person_session')
  })
})

describe('workspaceAccess — a member-gated workspace', () => {
  it('requires a person session for an unbound session', async () => {
    const profile = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-1'),
      displayName: 'Ada',
    })
    await members.addMember(WS, profile.id)
    expect(await workspaceAccess(UNBOUND_SESSION, WS, members)).toBe('requires_person_session')
  })

  it('refuses a bound session whose passkey was never pinned as a profile', async () => {
    const profile = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-1'),
      displayName: 'Ada',
    })
    await members.addMember(WS, profile.id)
    const grant = grantOf('signed-in', { origin: ORIGIN, credentialId: 'unknown-cred' })
    expect(await workspaceAccess(grant, WS, members)).toBe('not_a_member')
  })

  it('refuses a bound session whose profile exists but is not a member of THIS workspace', async () => {
    const gatingMember = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-gate'),
      displayName: 'Ada',
    })
    await members.addMember(WS, gatingMember.id)
    const outsider = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-outsider'),
      displayName: 'Bea',
    })
    const grant = grantOf('signed-in', { origin: ORIGIN, credentialId: 'cred-outsider' })
    expect(await workspaceAccess(grant, WS, members)).toBe('not_a_member')
    expect(outsider.id).not.toBe(gatingMember.id)
  })

  it('admits a bound session whose passkey belongs to a member', async () => {
    const profile = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-1'),
      displayName: 'Ada',
    })
    await members.addMember(WS, profile.id)
    const grant = grantOf('signed-in', { origin: ORIGIN, credentialId: 'cred-1' })
    expect(await workspaceAccess(grant, WS, members)).toBe('admitted')
  })
})

describe('workspaceAccess — membership monotonicity (user decision 2026-09-21)', () => {
  it('removing the LAST member keeps the workspace person-gated for an unbound session', async () => {
    const profile = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-1'),
      displayName: 'Ada',
    })
    await members.addMember(WS, profile.id)
    expect(await workspaceAccess(UNBOUND_SESSION, WS, members)).toBe('requires_person_session')

    await roles.remove(WS, profile.id)
    expect(await workspaceAccess(UNBOUND_SESSION, WS, members)).toBe('requires_person_session')
  })

  it('removing the last member refuses that former member’s own passkey as not_a_member', async () => {
    const profile = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-1'),
      displayName: 'Ada',
    })
    await members.addMember(WS, profile.id)
    await roles.remove(WS, profile.id)

    const grant = grantOf('signed-in', { origin: ORIGIN, credentialId: 'cred-1' })
    expect(await workspaceAccess(grant, WS, members)).toBe('not_a_member')
  })

  it('removing one member does not change another bound member’s answer', async () => {
    const removed = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-removed'),
      displayName: 'Ada',
    })
    const staying = await members.ensureProfile({
      binding: passkeyBinding(ORIGIN, 'cred-staying'),
      displayName: 'Bea',
    })
    await members.addMember(WS, removed.id)
    await members.addMember(WS, staying.id)

    await roles.remove(WS, removed.id)

    const stayingGrant = grantOf('signed-in', { origin: ORIGIN, credentialId: 'cred-staying' })
    const removedGrant = grantOf('signed-in', { origin: ORIGIN, credentialId: 'cred-removed' })
    expect(await workspaceAccess(stayingGrant, WS, members)).toBe('admitted')
    expect(await workspaceAccess(removedGrant, WS, members)).toBe('not_a_member')
  })
})

describe('membershipRefusal', () => {
  it('carries the two sentences replica-key already answered', () => {
    expect(membershipRefusal('requires_person_session')).toEqual({
      error: 'requires_person_session',
      message: 'this session is not signed in as a member',
    })
    expect(membershipRefusal('not_a_member')).toEqual({
      error: 'not_a_member',
      message: 'no such member in this workspace',
    })
  })
})

// ADR-0046: a person is whoever an authenticator vouched for, not only a
// passkey — the gate asks through the binding, whatever produced it.
describe('workspaceAccess — any authenticator', () => {
  const person = { authenticator: 'oidc:corp', subject: 'sub-42' }

  it('admits a member signed in through a non-passkey authenticator', async () => {
    const profile = await members.ensureProfile({ binding: person, displayName: 'Ada' })
    await members.addMember(WS, profile.id)
    expect(await workspaceAccess({ kind: 'signed-in', scopes: [], person }, WS, members)).toBe(
      'admitted',
    )
  })

  it('does not admit the same subject vouched for by a different authenticator', async () => {
    const profile = await members.ensureProfile({ binding: person, displayName: 'Ada' })
    await members.addMember(WS, profile.id)
    const impostor = { authenticator: 'oidc:other', subject: person.subject }
    expect(
      await workspaceAccess({ kind: 'signed-in', scopes: [], person: impostor }, WS, members),
    ).toBe('not_a_member')
  })
})

// ADR-0046 decision 10: every workspace is members-only from the start, not
// only once it has a member — nobody forgot to close one that was never open.
describe('workspaceAccess — members-only from the start', () => {
  const person = { authenticator: 'oidc:https://sso.corp.example', subject: 'ada-1' }

  it('refuses a workspace that has never had a member', async () => {
    const grant: ResolvedGrant = { kind: 'signed-in', scopes: [], person }
    expect(await workspaceAccess(grant, WS, members)).toBe('not_a_member')
  })

  it('admits a member, and still asks for a person when there is none', async () => {
    const profile = await members.ensureProfile({ binding: person, displayName: 'Ada' })
    await members.addMember(WS, profile.id)
    const signedIn: ResolvedGrant = { kind: 'signed-in', scopes: [], person }
    expect(await workspaceAccess(signedIn, WS, members)).toBe('admitted')
    const nobody: ResolvedGrant = { kind: 'external-bearer', scopes: [] }
    expect(await workspaceAccess(nobody, 'ws-2', members)).toBe('requires_person_session')
  })
})
