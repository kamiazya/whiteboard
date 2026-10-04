/**
 * Model-based: `isWorkspaceMember(ws, p)` must equal whether the LAST
 * add/remove op on that exact (ws, p) pair was an add, for any interleaved
 * sequence touching a small pool of workspaces and profiles — and
 * `roles.list(ws)` must never disagree with that same model.
 *
 * `membersOnly(ws)` is a SEPARATE, monotone model: true iff at least one
 * `addMember(ws, ·)` ever ran, for any workspace in the pool — removing
 * every member never clears it (user decision 2026-09-21).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import {
  createMemberProfileStore,
  type MemberProfileStore,
  passkeyBinding,
} from './member-profile-store.js'
import { createWorkspaceRoles, type WorkspaceRoles } from './workspace-roles.js'

const WORKSPACES = ['ws-1', 'ws-2'] as const
const PROFILE_KEYS = ['p1', 'p2', 'p3'] as const

const opArb = fc.record({
  kind: fc.constantFrom('add', 'remove'),
  ws: fc.constantFrom(...WORKSPACES),
  p: fc.constantFrom(...PROFILE_KEYS),
})

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let store: MemberProfileStore
let roles: WorkspaceRoles

// One migrated database for the file: the migrations are the cost of a run,
// the rows are not.
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-member-profiles-prop-'))
  handle = await createIsolatedDb({ dataDir: root })
  store = createMemberProfileStore(handle.db)
  roles = createWorkspaceRoles(handle.db, { ownedByTheMachine: true })
})
afterAll(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

// Every table the store writes, children first so no row outlives its parent.
async function clearRows(): Promise<void> {
  const { rawDb } = handle
  await rawDb.deleteFrom('workspaceMemberships').execute()
  await rawDb.deleteFrom('workspaceMembersOnly').execute()
  await rawDb.deleteFrom('memberProfiles').execute()
  await rawDb.deleteFrom('accountBindings').execute()
  await rawDb.deleteFrom('accounts').execute()
}

describe('membership seam', () => {
  // Each run is a real SQLite transaction per op over rows cleared at its
  // start, against one database migrated once for the file. Migrating per run
  // cost about 87 ms of every run: 60 runs took 5.2 s at load 21 and passed
  // the 3 s per-test budget at load 48 only by timing out (3.3 s), against
  // 0.9-1.1 s at the same load with one migration. 200 runs would still fit,
  // but 60 covers the add/remove interleavings that matter.
  fcTest.prop([fc.array(opArb, { maxLength: 30 })], withDefaults({ numRuns: 60 }))(
    'isWorkspaceMember and the roles list agree with whichever op ran last per (workspace, profile) pair',
    async (ops) => {
      // Fresh state per run: fast-check reuses this function body across
      // generated cases over the one database.
      await clearRows()

      const profileIds = new Map<string, string>()
      for (const key of PROFILE_KEYS) {
        const profile = await store.ensureProfile({
          binding: passkeyBinding('https://a.example', `cred-${key}`),
          displayName: key,
        })
        profileIds.set(key, profile.id)
      }

      const model = new Map<string, boolean>()
      const everAdded = new Set<string>()
      for (const op of ops) {
        const pairKey = `${op.ws}/${op.p}`
        const profileId = profileIds.get(op.p)
        if (profileId === undefined) throw new Error('unreachable: every pool key was minted')
        if (op.kind === 'add') {
          await store.addMember(op.ws, profileId)
          model.set(pairKey, true)
          everAdded.add(op.ws)
        } else {
          await roles.remove(op.ws, profileId)
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

        const members = await roles.list(ws)
        const expectedIds = new Set(
          PROFILE_KEYS.filter((p) => model.get(`${ws}/${p}`) === true).map(
            (p) => profileIds.get(p) as string,
          ),
        )
        expect(new Set(members.map((m) => m.profile.id))).toEqual(expectedIds)

        expect(await store.membersOnly(ws)).toBe(everAdded.has(ws))
      }
    },
  )
})
