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
import {
  describeThrown,
  generateDocumentId,
  parseWorkspaceAddress,
  workspaceSegmentSchema,
} from '@kamiazya/whiteboard-model'
import { type DocumentIndex, isWorkspaceSegmentTakenError } from '@kamiazya/whiteboard-ports'
import { hasRequiredScopes } from './auth-strategy.js'
import type { ResolvedGrant } from './credential-resolver.js'
import { MCP_TOOL_SCOPES } from './mcp-tool-scopes.js'
import type { MemberProfileStore } from './member-profile-store.js'
import { namespaceOfGrant } from './membership-gate.js'
import { serverModeToolErrorText } from './server-mode-redaction.js'
import { type MembershipDenial, membershipRefusal, workspaceAccess } from './workspace-access.js'

export interface McpCaller {
  readonly grant: ResolvedGrant
  readonly members: MemberProfileStore
}

const callers = new AsyncLocalStorage<McpCaller>()

/**
 * The text a failed tool call answers with. Server mode's caller is a member,
 * not the operator, so a fault's text (a storage path, SQL, engine detail)
 * goes to the log rather than to them; the local daemon and stdio answer
 * their owner with all of it.
 */
export function toolErrorText(tool: string, err: unknown): string {
  return callers.getStore() === undefined ? describeThrown(err) : serverModeToolErrorText(tool, err)
}

/**
 * The gate's own refusals. Named, so server mode's error text passes them to
 * the caller verbatim as the refusals they are.
 */
class McpCallRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpCallRefusalError'
  }
}

/**
 * Whose namespace a bare segment means for the tool call being served
 * (ADR-0053) — the same answer the gate below resolves with — or undefined
 * outside a server-mode call, where the keeper's one namespace applies.
 */
export async function mcpCallerNamespace(): Promise<string | undefined> {
  const caller = callers.getStore()
  return caller === undefined ? undefined : namespaceOfGrant(caller.grant, caller.members)
}

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

type GateIndex = Pick<DocumentIndex, 'resolveWorkspace' | 'createWorkspace'>

function refused(denial: MembershipDenial): Error {
  const { error, message } = membershipRefusal(denial)
  return new McpCallRefusalError(`${error}: ${message}`)
}

/**
 * `mcp:call` opens the endpoint; what the call may DO is the scope its `/api`
 * twin needs. Without this a token scoped for reading could delete through
 * `/mcp` what it could only read through `/api`. A tool with no entry is
 * refused, so an unmapped tool fails closed. The scopes are not quoted, as no
 * other auth refusal quotes them.
 */
function scopeRefusal(caller: McpCaller, toolName: string): Error | null {
  const required = MCP_TOOL_SCOPES[toolName]
  if (required !== undefined && hasRequiredScopes(caller.grant.scopes, required)) return null
  return new McpCallRefusalError(
    `insufficient_scope: this credential's scopes do not reach ${toolName}`,
  )
}

/**
 * Wraps a record of tools so a call runs only for a caller whose scopes reach
 * the tool and who is a member of the workspace it names, and a call naming none is refused unless the tool is in
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
  index: GateIndex,
): T {
  const wrapped: Record<string, WorkspaceScopedTool> = {}
  for (const [key, tool] of Object.entries(tools)) {
    wrapped[key] = {
      ...tool,
      execute: (input: never) => {
        const caller = callers.getStore()
        if (caller === undefined) return tool.execute(input)
        const insufficient = scopeRefusal(caller, tool.name)
        if (insufficient !== null) return Promise.reject(insufficient)
        const { workspaceId: handle } = (input ?? {}) as WorkspaceScopedInput
        if (typeof handle === 'string') return gatedCall(caller, index, handle, tool, input)
        if (handle === undefined && WORKSPACE_OPTIONAL_TOOLS.has(tool.name)) {
          return tool.execute(input)
        }
        return Promise.reject(
          new McpCallRefusalError(
            `workspace_required: ${tool.name} must name the workspace it acts on`,
          ),
        )
      },
    }
  }
  return wrapped as T
}

async function gatedCall(
  caller: McpCaller,
  index: GateIndex,
  handle: string,
  tool: WorkspaceScopedTool,
  input: never,
): Promise<unknown> {
  // A bare segment is looked up in the caller's own namespace (ADR-0053), so
  // a segment somebody else holds is no different here from one nobody does:
  // a read is refused alike, and a create mints the caller's own.
  const namespace = await namespaceOfGrant(caller.grant, caller.members)
  let existing = await index.resolveWorkspace(handle, namespace)
  if (existing === null && (input as WorkspaceScopedInput).createWorkspace === true) {
    const minted = await mintAsFirstMember(caller, index, handle)
    if (minted === 'unmintable') return tool.execute(input)
    if (minted !== 'taken' && minted !== 'foreign') {
      return tool.execute({ ...(input as object), workspaceId: minted } as never)
    }
    // `taken`: a concurrent call of the caller's own minted the segment after
    // the check above; it is in their namespace, so the gate below admits
    // them. `foreign`: another namespace's segment, which the gate below
    // refuses whether or not it exists.
    existing = await index.resolveWorkspace(handle, namespace)
  }
  const access = await workspaceAccess(
    caller.grant,
    existing?.workspaceId ?? handle,
    caller.members,
  )
  if (access !== 'admitted') throw refused(access)
  // The id just authorized, not the handle: the tool would resolve it again,
  // and a rename in between could point that at another workspace.
  if (existing === null) return tool.execute(input)
  return tool.execute({ ...(input as object), workspaceId: existing.workspaceId } as never)
}

/**
 * The gate mints the workspace ITSELF, in the caller's own namespace, before
 * the tool runs, and makes the caller its member before anything is written.
 * Left to the tool, the mint would converge on whichever write lands first.
 * Here the segment's unique index decides — and since it is unique per
 * namespace, only another call by the same person can win it: whoever loses
 * gets `taken`, with nothing written. The id is fresh and known only to this
 * call until the membership lands.
 *
 * A batch refused after the mint leaves the caller a member of an empty
 * workspace, so their retry reaches it. A handle qualified by another
 * namespace is `foreign` and never minted (ADR-0053). One that cannot be a
 * segment is `unmintable`: the tool refuses it with its own reason, minting
 * nothing.
 */
async function mintAsFirstMember(
  caller: McpCaller,
  index: GateIndex,
  handle: string,
): Promise<string | 'taken' | 'foreign' | 'unmintable'> {
  const person = caller.grant.person
  const profile = person === undefined ? null : await caller.members.profileForBinding(person)
  if (profile === null) throw refused('requires_person_session')
  const address = parseWorkspaceAddress(handle)
  if (address?.form === 'qualified' && address.namespace !== profile.handle) return 'foreign'
  const segment = address?.form === 'qualified' ? address.segment : handle
  if (!workspaceSegmentSchema.safeParse(segment).success) return 'unmintable'
  const workspaceId = generateDocumentId()
  try {
    await index.createWorkspace({ workspaceId, namespace: profile.handle, segment })
  } catch (err) {
    if (isWorkspaceSegmentTakenError(err)) return 'taken'
    throw err
  }
  await caller.members.addMember(workspaceId, profile.id)
  return workspaceId
}
