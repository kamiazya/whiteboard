import { z } from 'zod'

/**
 * ADR-0049 decision 1: a workspace's people as its owners manage them. Server
 * mode is the keeper with people (ADR-0050 decision 3): any member may read
 * the list, and only a member whose role is `owner` changes it. Deliberately
 * free of any node:* import — the browser consumes these schemas directly.
 */

// The one spelling of a workspace role; the server's role types are its `z.infer`.
const workspaceRoleSchema = z.enum(['owner', 'member'])
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>

export const workspacePersonSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
  role: workspaceRoleSchema,
  // Kept a member while deactivated, so reactivating restores exactly
  // what they had (decision 4); the list says so rather than hiding them.
  deactivated: z.boolean(),
})

export const workspacePeopleResponseSchema = z.object({
  people: z.array(workspacePersonSchema),
  // Whether the caller may change these people — the keeper decides who
  // that is, so a screen asks rather than guessing.
  canManage: z.boolean(),
})

export const addWorkspacePersonRequestSchema = z.object({ userId: z.string().min(1) }).strict()

export const changeWorkspaceRoleRequestSchema = z.object({ role: workspaceRoleSchema }).strict()

export const removeWorkspacePersonResponseSchema = z.object({ removed: z.literal(true) })

/**
 * ADR-0049 decision 3: a single-use, expiring link into this workspace, or
 * (created by an administrator) into the tenant alone. The
 * token rides the URL's fragment, which a browser never sends to a server or
 * puts in a Referer; the link itself is the secret, so it is shown once.
 */
export const invitationLinkResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
})

/**
 * How many links into one workspace may be pending (unredeemed and
 * unexpired) at once. A link is a credential that admits whoever holds it,
 * so an owner who mints them in a loop is stopped well before the list stops
 * being something a person can review; revoking one makes room.
 */
export const MAX_PENDING_WORKSPACE_INVITATIONS = 50

/**
 * A link into this workspace that is still pending, as its owners review it.
 * Never the token or its hash: the link was shown once, at minting, and a
 * list that carried it would hand every owner every other owner's links.
 */
const pendingInvitationSchema = z.object({
  id: z.string().min(1),
  invitedBy: z.string().min(1),
  createdAt: z.string(),
  expiresAt: z.string(),
})

export const pendingInvitationsResponseSchema = z.object({
  invitations: z.array(pendingInvitationSchema),
})

export const revokeInvitationResponseSchema = z.object({ revoked: z.literal(true) })

/**
 * Why a change was refused. `last_owner`: the product never leaves a
 * workspace without an owner, so its last owner can be neither demoted nor
 * removed. `too_many_invitations`: {@link MAX_PENDING_WORKSPACE_INVITATIONS}
 * links are already pending. `too_many_workspaces`: an owner's demotion or
 * removal would hand the workspace to the next owner, whose namespace already
 * holds the most workspaces one person may on this server — the same code a
 * create past that ceiling answers. `sign_in_required`: an owner's change came
 * through a bearer, and only a browser sign-in administers a workspace's
 * people, as it does a tenant's. A narrowing of `apiErrorBodySchema`'s `{ error, message }` arm.
 */
export const workspacePeopleRefusalSchema = z.object({
  error: z.enum([
    'not_an_owner',
    'unknown_user',
    'not_a_member',
    'last_owner',
    'unknown_invitation',
    'too_many_invitations',
    'too_many_workspaces',
    'sign_in_required',
  ]),
  message: z.string().min(1),
})

export type WorkspacePeopleRefusal = z.infer<typeof workspacePeopleRefusalSchema>
