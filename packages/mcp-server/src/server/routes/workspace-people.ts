/**
 * ADR-0049 decisions 1 and 5: a workspace's people, managed by its owners,
 * on both keepers. The `/api` middleware has already admitted the caller to
 * the workspace, so reading needs nothing more; each change asks the keeper
 * whether this caller may make it (`../security/people-keepers.ts`, where the
 * two keepers differ).
 */
import {
  addWorkspacePersonRequestSchema,
  changeWorkspaceRoleRequestSchema,
  removeWorkspacePersonResponseSchema,
  type WorkspacePeopleRefusal,
  workspacePeopleResponseSchema,
  workspacePersonSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { errorBody, invalidRequestBody } from '@kamiazya/whiteboard-server-core'
import { type Context, Hono } from 'hono'
import type { z } from 'zod'
import { getLogger } from '../log.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import type { WorkspacePeopleKeeper } from '../security/people-keepers.js'
import type { WorkspaceMember, WorkspaceRoles } from '../security/workspace-roles.js'
import { workspaceIdFromHandle } from '../workspace-handle.js'
import { issueInvitationLink } from './invitation-link.js'
import { endSyncStreamsOf } from './sync-sse.js'

const log = getLogger('workspace-people')

interface WorkspacePeopleRouterOptions {
  readonly members: MemberProfileStore
  readonly roles: WorkspaceRoles
  readonly keeper: WorkspacePeopleKeeper
}

const REFUSALS = {
  not_an_owner: [403, 'only an owner of this workspace can change its people'],
  unknown_user: [404, 'no user by that id here'],
  not_a_member: [404, 'no such member in this workspace'],
  last_owner: [409, 'a workspace keeps at least one owner; make someone else an owner first'],
} as const satisfies Record<WorkspacePeopleRefusal['error'], readonly [number, string]>

function refuse(c: Context, error: WorkspacePeopleRefusal['error']) {
  const [status, message] = REFUSALS[error]
  log.warning({ path: c.req.path, reason: error }, 'workspace people change refused')
  return c.json({ error, message } satisfies WorkspacePeopleRefusal, status)
}

// Why the roles store turned a change down, as this API says it.
function refuseChange(c: Context, why: 'not-a-member' | 'last-owner') {
  return refuse(c, why === 'not-a-member' ? 'not_a_member' : 'last_owner')
}

function toPerson(member: WorkspaceMember) {
  return workspacePersonSchema.parse({
    userId: member.profile.id,
    displayName: member.profile.displayName,
    role: member.role,
    deactivated: member.deactivated,
  })
}

async function readBody<S extends z.ZodTypeAny>(c: Context, schema: S) {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { error: c.json(errorBody('invalid_body', 'the request body is not valid JSON'), 400) }
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return { error: c.json(invalidRequestBody(parsed.error), 400) }
  return { data: parsed.data as z.infer<S> }
}

const workspaceOf = (c: Context) => workspaceIdFromHandle(c, c.req.param('workspace') ?? '')

// The workspace this request addresses, when its caller may change its people.
async function ownedBy(c: Context, keeper: WorkspacePeopleKeeper): Promise<string | null> {
  const workspaceId = await workspaceOf(c)
  return (await keeper.canManage(c, workspaceId)) ? workspaceId : null
}

async function findPerson(roles: WorkspaceRoles, workspaceId: string, userId: string) {
  const found = (await roles.list(workspaceId)).find((m) => m.profile.id === userId)
  return found === undefined ? null : toPerson(found)
}

// ADR-0049 decision 3: an owner invites a person into the workspace.
function mountInvitations(app: Hono, keeper: WorkspacePeopleKeeper): void {
  const { invitations } = keeper
  if (invitations === undefined) return
  const { store, origin } = invitations
  app.post('/api/workspaces/:workspace/invitations', async (c) => {
    const workspaceId = await ownedBy(c, keeper)
    const invitedBy = await keeper.actingUserId(c)
    if (workspaceId === null || invitedBy === null) return refuse(c, 'not_an_owner')
    const body = await issueInvitationLink(store, origin, { invitedBy, workspaceId })
    return c.json(body, 201)
  })
}

export function createWorkspacePeopleRouter(options: WorkspacePeopleRouterOptions) {
  const { members, roles, keeper } = options
  const app = new Hono()
  const ownedWorkspace = (c: Context) => ownedBy(c, keeper)
  const personIn = (workspaceId: string, userId: string) => findPerson(roles, workspaceId, userId)

  app.get('/api/workspaces/:workspace/people', async (c) => {
    const workspaceId = await workspaceOf(c)
    const people = (await roles.list(workspaceId)).map(toPerson)
    const canManage = await keeper.canManage(c, workspaceId)
    return c.json(workspacePeopleResponseSchema.parse({ people, canManage }), 200)
  })

  app.post('/api/workspaces/:workspace/people', async (c) => {
    const body = await readBody(c, addWorkspacePersonRequestSchema)
    if (body.error !== undefined) return body.error
    const workspaceId = await ownedWorkspace(c)
    if (workspaceId === null) return refuse(c, 'not_an_owner')
    const { userId } = body.data
    if (!(await roles.isUser(userId))) return refuse(c, 'unknown_user')
    await members.addMember(workspaceId, userId)
    return c.json(await personIn(workspaceId, userId), 201)
  })

  app.patch('/api/workspaces/:workspace/people/:userId', async (c) => {
    const body = await readBody(c, changeWorkspaceRoleRequestSchema)
    if (body.error !== undefined) return body.error
    const workspaceId = await ownedWorkspace(c)
    if (workspaceId === null) return refuse(c, 'not_an_owner')
    const userId = c.req.param('userId')
    const changed = await roles.setRole(workspaceId, userId, body.data.role)
    if (changed !== 'ok') return refuseChange(c, changed)
    return c.json(await personIn(workspaceId, userId), 200)
  })

  app.delete('/api/workspaces/:workspace/people/:userId', async (c) => {
    const workspaceId = await ownedWorkspace(c)
    if (workspaceId === null) return refuse(c, 'not_an_owner')
    const userId = c.req.param('userId')
    const removed = await roles.remove(workspaceId, userId)
    if (removed !== 'ok') return refuseChange(c, removed)
    await keeper.afterRemove?.(userId)
    endSyncStreamsOf(userId)
    return c.json(removeWorkspacePersonResponseSchema.parse({ removed: true }), 200)
  })

  mountInvitations(app, keeper)

  return app
}
