/**
 * Model-based: `isWorkspaceMember(ws, p)` must equal whether the LAST
 * add/revoke op on that exact (ws, p) pair was an add, for any interleaved
 * sequence touching a small pool of workspaces and profiles — and
 * `listMembers(ws)` must never disagree with that same model.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'

const WORKSPACES = ['ws-1', 'ws-2'] as const
const PROFILE_KEYS = ['p1', 'p2', 'p3'] as const

const opArb = fc.record({
  kind: fc.constantFrom('add', 'revoke'),
  ws: fc.constantFrom(...WORKSPACES),
  p: fc.constantFrom(...PROFILE_KEYS),
})

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let store: MemberProfileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-member-profiles-prop-'))
  handle = await createIsolatedDb({ dataDir: root })
  store = createMemberProfileStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('membership seam', () => {
  // A real SQLite (migrations + a transaction per op) is created per run, so
  // the library default of 200 runs takes ~7s here — measured over the
  // mcp-node per-file budget. 60 keeps the file comfortably under it while
  // still covering the add/revoke interleavings that matter.
  fcTest.prop([fc.array(opArb, { maxLength: 30 })], withDefaults({ numRuns: 60 }))(
    'isWorkspaceMember and listMembers agree with whichever op ran last per (workspace, profile) pair',
    async (ops) => {
      // Fresh state per run: dispose the previous handle and mint a new one,
      // since fast-check reuses this function body across generated cases.
      await handle.dispose()
      root = await mkdtemp(join(tmpdir(), 'wb-member-profiles-prop-'))
      handle = await createIsolatedDb({ dataDir: root })
      store = createMemberProfileStore(handle.db)

      const profileIds = new Map<string, string>()
      for (const key of PROFILE_KEYS) {
        const profile = await store.ensureProfile({
          origin: 'https://a.example',
          credentialId: `cred-${key}`,
          displayName: key,
        })
        profileIds.set(key, profile.id)
      }

      const model = new Map<string, boolean>()
      for (const op of ops) {
        const pairKey = `${op.ws}/${op.p}`
        const profileId = profileIds.get(op.p)
        if (profileId === undefined) throw new Error('unreachable: every pool key was minted')
        if (op.kind === 'add') {
          await store.addMember(op.ws, profileId)
          model.set(pairKey, true)
        } else {
          await store.revokeL1Membership(op.ws, profileId)
          model.set(pairKey, false)
        }
      }

      for (const ws of WORKSPACES) {
        for (const p of PROFILE_KEYS) {
          const profileId = profileIds.get(p)
          if (profileId === undefined) throw new Error('unreachable')
          const expected = model.get(`${ws}/${p}`) === true
          const status = await store.isWorkspaceMember(ws, profileId)
          expect(status).toBe(expected ? 'member' : 'not-a-member')
        }

        const members = await store.listMembers(ws)
        const expectedIds = new Set(
          PROFILE_KEYS.filter((p) => model.get(`${ws}/${p}`) === true).map(
            (p) => profileIds.get(p) as string,
          ),
        )
        expect(new Set(members.map((m) => m.id))).toEqual(expectedIds)
      }
    },
  )
})
