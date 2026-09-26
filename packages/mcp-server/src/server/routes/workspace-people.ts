/**
 * ADR-0049 decision 1 on server mode: a workspace's owners manage its
 * people. The `/api` middleware has already admitted only members (every
 * workspace there is members-only), so reading needs nothing more; each
 * change checks that the caller is an owner. Mounted on server mode alone:
 * the local daemon's members are still passkeys (`membership.ts`) until the
 * two keepers share this surface (decision 5).
 */
import {
  addWorkspacePersonRequestSchema,
  changeWorkspaceRoleRequestSchema,
  type WorkspacePeopleRefusal,
  workspacePeopleResponseSchema,
  workspacePersonSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { errorBody, invalidRequestBody } from '@kamiazya/whiteboard-server-core'
import { type Context, Hono } from 'hono'
import type { z } from 'zod'
import { getLogger } from '../log.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import { callerUserId } from '../security/membership-gate.js'
import type { WorkspaceMember, WorkspaceRoles } from '../security/workspace-roles.js'
import { workspaceIdFromHandle } from '../workspace-handle.js'

const log = getLogger('workspace-people')

interface WorkspacePeopleRouterOptions {
  readonly members: MemberProfileStore
  readonly roles: WorkspaceRoles
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

export function createWorkspacePeopleRouter({ members, roles }: WorkspacePeopleRouterOptions) {
  const app = new Hono()
  const workspaceOf = (c: Context) => workspaceIdFromHandle(c, c.req.param('workspace') ?? '')

  // The workspace this request addresses, when its caller owns it.
  async function ownedWorkspace(c: Context): Promise<string | null> {
    const workspaceId = await workspaceOf(c)
    const caller = await callerUserId(c, members)
    if (caller === null) return null
    return (await members.membershipRole(workspaceId, caller)) === 'owner' ? workspaceId : null
  }

  async function personIn(workspaceId: string, userId: string) {
    const found = (await roles.list(workspaceId)).find((m) => m.profile.id === userId)
    return found === undefined ? null : toPerson(found)
  }

  app.get('/api/workspaces/:workspace/people', async (c) => {
    const people = (await roles.list(await workspaceOf(c))).map(toPerson)
    return c.json(workspacePeopleResponseSchema.parse({ people }), 200)
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
    if (changed === 'not-a-member') return refuse(c, 'not_a_member')
    if (changed === 'last-owner') return refuse(c, 'last_owner')
    return c.json(await personIn(workspaceId, userId), 200)
  })

  app.delete('/api/workspaces/:workspace/people/:userId', async (c) => {
    const workspaceId = await ownedWorkspace(c)
    if (workspaceId === null) return refuse(c, 'not_an_owner')
    const removed = await roles.remove(workspaceId, c.req.param('userId'))
    if (removed === 'not-a-member') return refuse(c, 'not_a_member')
    if (removed === 'last-owner') return refuse(c, 'last_owner')
    return c.json({ removed: true }, 200)
  })

  return app
}
