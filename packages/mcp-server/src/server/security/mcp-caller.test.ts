/**
 * ADR-0046 decision 10 on server mode's `/mcp`: a tool call that names a
 * workspace reaches it only for a member, and a call that creates one makes
 * its caller the first member. Outside a server-mode request (the local
 * daemon, stdio) there is no caller and nothing is gated.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import type { ResolvedGrant } from './credential-resolver.js'
import { gatedByMembership, runAsMcpCaller } from './mcp-caller.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'

const ada = { authenticator: 'oidc:test', subject: 'ada' }
const bearerOf = (person: typeof ada): ResolvedGrant => ({
  kind: 'external-bearer',
  scopes: ['mcp:call'],
  person,
})

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let workspaces: Map<string, WorkspaceEntry>
let executed: unknown[]

// One tool whose execute records what reached it, and — like
// wb_workspace_edit — mints the workspace a createWorkspace call names.
function tools() {
  const index = {
    resolveWorkspace: async (h: string) =>
      workspaces.get(h) ?? [...workspaces.values()].find((w) => w.workspaceId === h) ?? null,
  }
  return gatedByMembership(
    {
      edit: {
        async execute(input: { workspaceId?: string; createWorkspace?: boolean; fail?: boolean }) {
          executed.push(input)
          if (input.createWorkspace && input.workspaceId && !workspaces.has(input.workspaceId)) {
            workspaces.set(input.workspaceId, {
              workspaceId: `ws-${input.workspaceId}`,
              segment: input.workspaceId,
            })
          }
          // A batch whose later op fails after the workspace was minted.
          if (input.fail) throw new Error('op 2 failed')
          return { ok: true }
        },
      },
    },
    index,
  ).edit
}

const asAda = <T>(fn: () => Promise<T>) => runAsMcpCaller({ grant: bearerOf(ada), members }, fn)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-mcp-caller-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  workspaces = new Map([['plans', { workspaceId: 'ws-plans', segment: 'plans' }]])
  executed = []
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('gatedByMembership', () => {
  it('passes every call through outside a server-mode request', async () => {
    await tools().execute({ workspaceId: 'plans' })
    expect(executed).toHaveLength(1)
  })

  it('admits a member to the workspace, by segment or by id', async () => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await members.addMember('ws-plans', profile.id)
    await asAda(() => tools().execute({ workspaceId: 'plans' }))
    await asAda(() => tools().execute({ workspaceId: 'ws-plans' }))
    expect(executed).toHaveLength(2)
  })

  it('refuses a non-member by name, and runs nothing', async () => {
    await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await expect(asAda(() => tools().execute({ workspaceId: 'plans' }))).rejects.toThrow(
      /not_a_member/,
    )
    expect(executed).toEqual([])
  })

  // The same answer as for an existing workspace, so the refusal says
  // nothing about which workspaces exist.
  it('refuses a workspace that does not exist the same way', async () => {
    await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await expect(asAda(() => tools().execute({ workspaceId: 'nowhere' }))).rejects.toThrow(
      /not_a_member/,
    )
  })

  it('makes the creator of a new workspace its first member', async () => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await asAda(() => tools().execute({ workspaceId: 'fresh', createWorkspace: true }))
    expect(await members.isWorkspaceMember('ws-fresh', profile.id)).toBe('member')
    await asAda(() => tools().execute({ workspaceId: 'fresh' }))
    expect(executed).toHaveLength(2)
  })

  it('refuses to create a workspace for a person who is no user here', async () => {
    await expect(
      asAda(() => tools().execute({ workspaceId: 'fresh', createWorkspace: true })),
    ).rejects.toThrow(/requires_person_session/)
    expect(executed).toEqual([])
  })

  // createWorkspace is an idempotent bootstrap: on an existing workspace it is
  // an ordinary write, so it must not be a way in.
  it('does not let createWorkspace into an existing workspace', async () => {
    await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await expect(
      asAda(() => tools().execute({ workspaceId: 'plans', createWorkspace: true })),
    ).rejects.toThrow(/not_a_member/)
    expect(executed).toEqual([])
  })

  // The tool runs against the workspace that was authorized, not a second
  // resolution of the handle that a rename in between could point elsewhere.
  it('runs the tool against the canonical id it authorized', async () => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await members.addMember('ws-plans', profile.id)
    await asAda(() => tools().execute({ workspaceId: 'plans' }))
    expect(executed).toEqual([{ workspaceId: 'ws-plans' }])
  })

  // A batch that minted the workspace and then failed leaves the creator a
  // member, or their retry would be refused from their own workspace.
  it('keeps the creator a member of a workspace a failing batch minted', async () => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await expect(
      asAda(() => tools().execute({ workspaceId: 'fresh', createWorkspace: true, fail: true })),
    ).rejects.toThrow(/op 2 failed/)
    expect(await members.isWorkspaceMember('ws-fresh', profile.id)).toBe('member')
  })

  it('passes a call that names no workspace through', async () => {
    await asAda(() => tools().execute({}))
    expect(executed).toHaveLength(1)
  })
})
