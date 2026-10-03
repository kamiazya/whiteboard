/**
 * ADR-0046 decision 10 on server mode's `/mcp`: who is calling a tool, and
 * whether they reach the workspace the call names.
 *
 * The MCP SDK hands a tool nothing of the HTTP request, so the caller rides
 * an AsyncLocalStorage the `/mcp` middleware opens for the request. Outside
 * one — the local daemon, stdio — there is no caller and nothing is gated,
 * which is exactly those surfaces' behaviour today.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import type { ResolvedGrant } from './credential-resolver.js'
import type { MemberProfileStore } from './member-profile-store.js'
import { type MembershipDenial, membershipRefusal, workspaceAccess } from './workspace-access.js'

export interface McpCaller {
  readonly grant: ResolvedGrant
  readonly members: MemberProfileStore
}

const callers = new AsyncLocalStorage<McpCaller>()

export function runAsMcpCaller<T>(caller: McpCaller, fn: () => Promise<T>): Promise<T> {
  return callers.run(caller, fn)
}

interface WorkspaceScopedTool {
  readonly name: string
  execute(input: never): Promise<unknown>
}

/**
 * The tools a call may make without naming a workspace. The gate selects on
 * the `workspaceId` field, so every other tool that names none is refused
 * rather than run ungated: a tool added with its workspace under another
 * name fails closed instead of skipping the gate.
 *
 * `wb_facet_list` omits it deliberately: with none it answers only the
 * deployment's facet registry, which belongs to no workspace. Naming one
 * still goes through the gate.
 */
const WORKSPACE_OPTIONAL_TOOLS: ReadonlySet<string> = new Set(['wb_facet_list'])

interface WorkspaceScopedInput {
  readonly workspaceId?: unknown
  readonly createWorkspace?: unknown
}

function refused(denial: MembershipDenial): Error {
  const { error, message } = membershipRefusal(denial)
  return new Error(`${error}: ${message}`)
}

/**
 * Wraps a record of tools so a call runs only for a member of the workspace it
 * names, and a call naming none is refused unless the tool is in
 * `WORKSPACE_OPTIONAL_TOOLS` — the same record-level seam as server-core's handle
 * resolution, and for its reason: a per-tool step is one the next tool would
 * not have. The tool objects are spread, so their schemas keep identity.
 *
 * A workspace that does not exist is refused the same way as one the caller
 * is not in, so the refusal says nothing about which exist — except for
 * `createWorkspace: true`, which creates it and makes the caller its first
 * member.
 */
export function gatedByMembership<T extends Record<string, WorkspaceScopedTool>>(
  tools: T,
  index: Pick<DocumentIndex, 'resolveWorkspace'>,
): T {
  const wrapped: Record<string, WorkspaceScopedTool> = {}
  for (const [key, tool] of Object.entries(tools)) {
    wrapped[key] = {
      ...tool,
      execute: (input: never) => {
        const caller = callers.getStore()
        if (caller === undefined) return tool.execute(input)
        const { workspaceId: handle } = (input ?? {}) as WorkspaceScopedInput
        if (typeof handle === 'string') return gatedCall(caller, index, handle, tool, input)
        if (handle === undefined && WORKSPACE_OPTIONAL_TOOLS.has(tool.name)) {
          return tool.execute(input)
        }
        return Promise.reject(
          new Error(`workspace_required: ${tool.name} must name the workspace it acts on`),
        )
      },
    }
  }
  return wrapped as T
}

async function gatedCall(
  caller: McpCaller,
  index: Pick<DocumentIndex, 'resolveWorkspace'>,
  handle: string,
  tool: WorkspaceScopedTool,
  input: never,
): Promise<unknown> {
  const existing = await index.resolveWorkspace(handle)
  if (existing === null && (input as WorkspaceScopedInput).createWorkspace === true) {
    return createAsFirstMember(caller, index, handle, () => tool.execute(input))
  }
  const access = await workspaceAccess(
    caller.grant,
    existing?.workspaceId ?? handle,
    caller.members,
    { membersOnlyByDefault: true },
  )
  if (access !== 'admitted') throw refused(access)
  // The id just authorized, not the handle: the tool would resolve it again,
  // and a rename in between could point that at another workspace.
  if (existing === null) return tool.execute(input)
  return tool.execute({ ...(input as object), workspaceId: existing.workspaceId } as never)
}

// ponytail: two people creating the same new segment at the same instant both
// pass the "does not exist" check, and the loser's write lands in the winner's
// workspace; membership still goes only to whoever finishes first. Closing it
// needs the mint to take the membership in the same write, in server-core.
async function createAsFirstMember(
  caller: McpCaller,
  index: Pick<DocumentIndex, 'resolveWorkspace'>,
  handle: string,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const person = caller.grant.person
  const profile = person === undefined ? null : await caller.members.profileForBinding(person)
  if (profile === null) throw refused('requires_person_session')
  try {
    return await run()
  } finally {
    // Also when the batch failed after minting: otherwise the creator's retry
    // is refused from a workspace that exists and has no member.
    const created = await index.resolveWorkspace(handle)
    if (created !== null && !(await caller.members.membersOnly(created.workspaceId))) {
      await caller.members.addMember(created.workspaceId, profile.id)
    }
  }
}
