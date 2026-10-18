/**
 * ADR-0046 decision 10 on server mode's `/mcp`: a tool call that names a
 * workspace reaches it only for a member, and a call that creates one makes
 * its caller the first member. Outside a server-mode request (the local
 * daemon, stdio) there is no caller and nothing is gated.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type WorkspaceEntry, WorkspaceSegmentTakenError } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { ALL_AUTH_SCOPES } from './auth-strategy.js'
import type { ResolvedGrant } from './credential-resolver.js'
import { gatedByMembership, runAsMcpCaller } from './mcp-caller.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'

const ada = { authenticator: 'oidc:test', subject: 'ada' }
const bearerOf = (person: typeof ada): ResolvedGrant => ({
  kind: 'external-bearer',
  scopes: ALL_AUTH_SCOPES,
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
    createWorkspace,
  }
  return gatedByMembership(
    {
      edit: {
        name: 'wb_workspace_edit',
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

async function createWorkspace(entry: { workspaceId: string; segment: string }) {
  if (workspaces.has(entry.segment)) throw new WorkspaceSegmentTakenError(entry.segment)
  workspaces.set(entry.segment, entry)
}
const idOf = (segment: string) => workspaces.get(segment)?.workspaceId ?? 'none'

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
    expect(await members.isWorkspaceMember(idOf('fresh'), profile.id)).toBe('member')
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
    expect(await members.isWorkspaceMember(idOf('fresh'), profile.id)).toBe('member')
  })

  // The gate mints before the batch runs, so a batch it refuses still leaves
  // the creator in the workspace they asked for, and the batch's own error
  // reaches them rather than a failure from the grant.
  it('rethrows the error of a refused batch, keeping its creator a member', async () => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    const gated = gatedByMembership(
      {
        edit: {
          name: 'wb_workspace_edit',
          async execute(_input: { workspaceId?: string; createWorkspace?: boolean }) {
            throw new Error('refused before writing')
          },
        },
      },
      { resolveWorkspace: async (h: string) => workspaces.get(h) ?? null, createWorkspace },
    ).edit
    await expect(
      asAda(() => gated.execute({ workspaceId: 'fresh', createWorkspace: true })),
    ).rejects.toThrow(/refused before writing/)
    expect(await members.isWorkspaceMember(idOf('fresh'), profile.id)).toBe('member')
  })

  // Minting nothing leaves nothing the caller is a member of, so the tool
  // must not run: left to it, a createWorkspace call would write ungated.
  it('refuses a handle that cannot be a segment, minting and running nothing', async () => {
    await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await expect(
      asAda(() => tools().execute({ workspaceId: '-', createWorkspace: true })),
    ).rejects.toThrow(/not_a_member/)
    expect(executed).toEqual([])
    expect(workspaces.has('-')).toBe(false)
  })

  // The gate selects on the workspace field, so a call without it must not be
  // a way to skip the gate: it fails closed unless the tool is allowlisted.
  it('refuses a call that names no workspace, and runs nothing', async () => {
    await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await expect(asAda(() => tools().execute({}))).rejects.toThrow(/workspace_required/)
    await expect(asAda(() => tools().execute({ workspaceId: 42 } as never))).rejects.toThrow(
      /workspace_required/,
    )
    expect(executed).toEqual([])
  })

  it('passes an allowlisted tool through when it names no workspace', async () => {
    const optional = {
      async execute(input: unknown) {
        executed.push(input)
        return { ok: true }
      },
    }
    const gated = gatedByMembership(
      { facetList: { ...optional, name: 'wb_facet_list' } },
      { resolveWorkspace: async () => null, createWorkspace },
    )
    await asAda(() => gated.facetList.execute({}))
    expect(executed).toEqual([{}])
  })

  it('still gates an allowlisted tool that does name a workspace', async () => {
    await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    const gated = gatedByMembership(
      { facetList: { name: 'wb_facet_list', execute: async (input: unknown) => input } },
      { resolveWorkspace: async (h: string) => workspaces.get(h) ?? null, createWorkspace },
    )
    await expect(asAda(() => gated.facetList.execute({ workspaceId: 'plans' }))).rejects.toThrow(
      /not_a_member/,
    )
  })

  it('refuses a tool its scopes do not reach before asking about membership', async () => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await members.addMember('ws-plans', profile.id)
    const reader: ResolvedGrant = { ...bearerOf(ada), scopes: ['mcp:call', 'canvas:read'] }
    await expect(
      runAsMcpCaller({ grant: reader, members }, () => tools().execute({ workspaceId: 'plans' })),
    ).rejects.toThrow(/insufficient_scope/)
    expect(executed).toEqual([])
  })

  it.for([
    ['a document.set', [{ op: 'document.set', documentId: 'd1', markdown: '# Plan' }]],
    [
      'a create carrying a body',
      [{ op: 'document.create', path: 'notes', kind: 'markdown', markdown: '# Plan' }],
    ],
  ] as const)('holds %s to canvas:write, as content is everywhere else', async ([, ops]) => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await members.addMember('ws-plans', profile.id)
    const placer: ResolvedGrant = { ...bearerOf(ada), scopes: ['mcp:call', 'workspace:write'] }
    await expect(
      runAsMcpCaller({ grant: placer, members }, () =>
        tools().execute({ workspaceId: 'plans', ops } as never),
      ),
    ).rejects.toThrow(/insufficient_scope/)
    expect(executed).toEqual([])

    const writer: ResolvedGrant = { ...placer, scopes: [...placer.scopes, 'canvas:write'] }
    await runAsMcpCaller({ grant: writer, members }, () =>
      tools().execute({ workspaceId: 'plans', ops } as never),
    )
    expect(executed).toHaveLength(1)
  })

  it('lets workspace:write alone place documents that carry no body', async () => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await members.addMember('ws-plans', profile.id)
    const placer: ResolvedGrant = { ...bearerOf(ada), scopes: ['mcp:call', 'workspace:write'] }
    const ops = [
      { op: 'document.create', path: 'empty', kind: 'markdown' },
      { op: 'document.create', path: 'board', kind: 'spatial' },
      { op: 'document.move', documentId: 'd1', path: 'moved' },
      { op: 'document.delete', documentId: 'd2' },
    ]
    await runAsMcpCaller({ grant: placer, members }, () =>
      tools().execute({ workspaceId: 'plans', ops } as never),
    )
    expect(executed).toHaveLength(1)
  })

  it('refuses a tool that has no scope entry, whatever the grant holds', async () => {
    const gated = gatedByMembership(
      { unmapped: { name: 'wb_unmapped', execute: async (input: unknown) => input } },
      { resolveWorkspace: async (h: string) => workspaces.get(h) ?? null, createWorkspace },
    )
    await expect(asAda(() => gated.unmapped.execute({ workspaceId: 'plans' }))).rejects.toThrow(
      /insufficient_scope/,
    )
  })

  // Two people creating one new segment at once: the other mints it between
  // this call's "does not exist" and its write. Converging on the winner's
  // workspace would file this caller's documents where the winner reads them.
  it('refuses a create whose segment another person minted mid-call, writing nothing there', async () => {
    const profile = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    const bob = await members.ensureProfile({
      binding: { authenticator: 'oidc:test', subject: 'bob' },
      displayName: 'Bob',
    })
    const writes: string[] = []
    let raced = false
    const index = {
      async resolveWorkspace(h: string) {
        const found =
          workspaces.get(h) ?? [...workspaces.values()].find((w) => w.workspaceId === h) ?? null
        if (h === 'fresh' && !raced) {
          raced = true
          workspaces.set('fresh', { workspaceId: 'ws-bob', segment: 'fresh' })
          await members.addMember('ws-bob', bob.id)
        }
        return found
      },
      async createWorkspace({ workspaceId, segment }: { workspaceId: string; segment: string }) {
        if (workspaces.has(segment)) throw new WorkspaceSegmentTakenError(segment)
        workspaces.set(segment, { workspaceId, segment })
      },
    }
    // Like wb_workspace_edit: createWorkspace converges on whatever the
    // handle resolves to, minting only when it names nothing.
    const gated = gatedByMembership(
      {
        edit: {
          name: 'wb_workspace_edit',
          async execute(input: { workspaceId: string; createWorkspace?: boolean }) {
            const entry = await index.resolveWorkspace(input.workspaceId)
            writes.push(entry?.workspaceId ?? `minted-${input.workspaceId}`)
            return { ok: true }
          },
        },
      },
      index,
    ).edit
    await expect(
      asAda(() => gated.execute({ workspaceId: 'fresh', createWorkspace: true })),
    ).rejects.toThrow(/not_a_member/)
    expect(writes).toEqual([])
    expect(await members.isWorkspaceMember('ws-bob', profile.id)).not.toBe('member')
  })
})
