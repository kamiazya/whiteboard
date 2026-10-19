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
  MAX_PENDING_WORKSPACE_INVITATIONS,
  pendingInvitationsResponseSchema,
  removeWorkspacePersonResponseSchema,
  revokeInvitationResponseSchema,
  type WorkspacePeopleRefusal,
  workspacePeopleResponseSchema,
  workspacePersonSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { invalidRequestBody } from '@kamiazya/whiteboard-server-core'
import { type Context, Hono } from 'hono'
import { getLogger } from '../log.js'
import type { WorkspacePeopleAdministration } from '../security/people-administration.js'
import type { WorkspacePeopleKeeper } from '../security/people-keepers.js'
import type { WorkspaceMember, WorkspaceRoles } from '../security/workspace-roles.js'
import { endSyncStreamsOf } from '../sync-streams.js'
import { workspaceIdFromHandle } from '../workspace-handle.js'
import { issueInvitationLink } from './invitation-link.js'
import { readJsonBody } from './read-json-body.js'

const log = getLogger('workspace-people')

interface WorkspacePeopleRouterOptions {
  readonly people: WorkspacePeopleAdministration
  /** Read-only here: every change goes through `people`. */
  readonly roles: WorkspaceRoles
  readonly keeper: WorkspacePeopleKeeper
}

const REFUSALS = {
  not_an_owner: [403, 'only an owner of this workspace can change its people'],
  unknown_user: [404, 'no user by that id here'],
  not_a_member: [404, 'no such member in this workspace'],
  last_owner: [409, 'a workspace keeps at least one owner; make someone else an owner first'],
  unknown_invitation: [404, 'no pending invitation by that id in this workspace'],
  sign_in_required: [403, "changing a workspace's people needs a browser sign-in, not a bearer"],
  too_many_invitations: [
    409,
    `this workspace already has ${MAX_PENDING_WORKSPACE_INVITATIONS} pending invitations; revoke one first`,
  ],
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

const workspaceOf = (c: Context) => workspaceIdFromHandle(c, c.req.param('workspace') ?? '')

// The workspace this request addresses and who is changing its people, or the
// refusal to send. Who is acting is recorded so a change can re-check, when it
// runs, that they still own the workspace.
async function actingOwner(c: Context, keeper: WorkspacePeopleKeeper) {
  const workspaceId = await workspaceOf(c)
  const refusal = await keeper.mayChange(c, workspaceId)
  if (refusal !== null) return refuse(c, refusal)
  const by = await keeper.actingUserId(c)
  return by === null ? refuse(c, 'not_an_owner') : { workspaceId, by }
}

async function findPerson(roles: WorkspaceRoles, workspaceId: string, userId: string) {
  const found = (await roles.list(workspaceId)).find((m) => m.profile.id === userId)
  return found === undefined ? null : toPerson(found)
}

// ADR-0049 decision 3: an owner invites a person into the workspace.
function mountRemoval(
  app: Hono,
  people: WorkspacePeopleAdministration,
  keeper: WorkspacePeopleKeeper,
): void {
  app.delete('/api/workspaces/:workspace/people/:userId', async (c) => {
    const owner = await actingOwner(c, keeper)
    if (owner instanceof Response) return owner
    const { workspaceId, by } = owner
    const userId = c.req.param('userId')
    const removed = await people.remove(workspaceId, userId, by)
    if (removed.kind === 'refused') return refuse(c, removed.reason)
    // First, before anything that can fail: a stream they already hold would
    // otherwise keep delivering the workspace (ADR-0042).
    endSyncStreamsOf(userId, workspaceId)
    return c.json(removeWorkspacePersonResponseSchema.parse({ removed: true }), 200)
  })
}

function mountInvitations(app: Hono, keeper: WorkspacePeopleKeeper): void {
  const { invitations } = keeper
  if (invitations === undefined) return
  const { store, origin } = invitations
  app.post('/api/workspaces/:workspace/invitations', async (c) => {
    const owner = await actingOwner(c, keeper)
    if (owner instanceof Response) return owner
    const { workspaceId, by: invitedBy } = owner
    // ponytail: counted before the insert, so mints racing each other may
    // overshoot by however many are in flight — a bound on a flood, not an
    // exact count; a conditional insert if it ever needs to be exact.
    const pending = await store.listPending(workspaceId, Date.now())
    if (pending.length >= MAX_PENDING_WORKSPACE_INVITATIONS) {
      return refuse(c, 'too_many_invitations')
    }
    const body = await issueInvitationLink(store, origin, { invitedBy, workspaceId })
    return c.json(body, 201)
  })

  app.get('/api/workspaces/:workspace/invitations', async (c) => {
    const workspaceId = await workspaceOf(c)
    if (!(await keeper.owns(c, workspaceId))) return refuse(c, 'not_an_owner')
    const pending = await store.listPending(workspaceId, Date.now())
    const invitations = pending.map((invitation) => ({
      id: invitation.id,
      invitedBy: invitation.invitedBy,
      createdAt: new Date(invitation.createdAt).toISOString(),
      expiresAt: new Date(invitation.expiresAt).toISOString(),
    }))
    return c.json(pendingInvitationsResponseSchema.parse({ invitations }), 200)
  })

  app.delete('/api/workspaces/:workspace/invitations/:invitationId', async (c) => {
    const owner = await actingOwner(c, keeper)
    if (owner instanceof Response) return owner
    const { workspaceId, by } = owner
    const revoked = await store.revoke(workspaceId, c.req.param('invitationId'), by)
    if (revoked === 'not-an-owner') return refuse(c, 'not_an_owner')
    if (revoked === 'unknown') return refuse(c, 'unknown_invitation')
    log.notice({ workspaceId, invitationId: c.req.param('invitationId') }, 'invitation revoked')
    return c.json(revokeInvitationResponseSchema.parse({ revoked: true }), 200)
  })
}

export function createWorkspacePeopleRouter(options: WorkspacePeopleRouterOptions) {
  const { people, roles, keeper } = options
  const app = new Hono()
  const personIn = (workspaceId: string, userId: string) => findPerson(roles, workspaceId, userId)

  app.get('/api/workspaces/:workspace/people', async (c) => {
    const workspaceId = await workspaceOf(c)
    const people = (await roles.list(workspaceId)).map(toPerson)
    const canManage = (await keeper.mayChange(c, workspaceId)) === null
    return c.json(workspacePeopleResponseSchema.parse({ people, canManage }), 200)
  })

  app.post('/api/workspaces/:workspace/people', async (c) => {
    const body = await readJsonBody(c, addWorkspacePersonRequestSchema, {
      voice: 'code',
      refuseShape: invalidRequestBody,
    })
    if ('refusal' in body) return body.refusal
    const owner = await actingOwner(c, keeper)
    if (owner instanceof Response) return owner
    const { workspaceId, by } = owner
    const { userId } = body.data
    const added = await people.add(workspaceId, userId, by)
    if (added.kind === 'refused') return refuse(c, added.reason)
    return c.json(await personIn(workspaceId, userId), 201)
  })

  app.patch('/api/workspaces/:workspace/people/:userId', async (c) => {
    const body = await readJsonBody(c, changeWorkspaceRoleRequestSchema, {
      voice: 'code',
      refuseShape: invalidRequestBody,
    })
    if ('refusal' in body) return body.refusal
    const owner = await actingOwner(c, keeper)
    if (owner instanceof Response) return owner
    const { workspaceId, by } = owner
    const userId = c.req.param('userId')
    const changed = await people.changeRole(workspaceId, userId, body.data.role, by)
    if (changed.kind === 'refused') return refuse(c, changed.reason)
    return c.json(await personIn(workspaceId, userId), 200)
  })

  mountRemoval(app, people, keeper)
  mountInvitations(app, keeper)

  return app
}
