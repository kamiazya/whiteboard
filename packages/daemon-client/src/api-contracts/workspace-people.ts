import { z } from 'zod'

/**
 * ADR-0049 decisions 1 and 5: a workspace's people as its owners manage
 * them, on either keeper. Any member may read the list; only an owner
 * changes it, and the keeper decides who that is — a member with the owner
 * role on server mode, the machine's owner on the local daemon. Deliberately free of any node:* import —
 * the browser consumes these schemas directly.
 */

export const workspaceRoleSchema = z.enum(['owner', 'member'])

export const workspacePersonSchema = z
  .object({
    userId: z.string().min(1),
    displayName: z.string().min(1),
    role: workspaceRoleSchema,
    // Kept a member while deactivated, so reactivating restores exactly
    // what they had (decision 4); the list says so rather than hiding them.
    deactivated: z.boolean(),
  })
  .strict()

export const workspacePeopleResponseSchema = z
  .object({
    people: z.array(workspacePersonSchema),
    // Whether the caller may change these people — the keeper decides who
    // that is (ADR-0049 decision 5), so a screen asks rather than guessing.
    canManage: z.boolean(),
  })
  .strict()

export const addWorkspacePersonRequestSchema = z.object({ userId: z.string().min(1) }).strict()

export const changeWorkspaceRoleRequestSchema = z.object({ role: workspaceRoleSchema }).strict()

export const removeWorkspacePersonResponseSchema = z.object({ removed: z.literal(true) }).strict()

/**
 * ADR-0049 decision 3: a single-use, expiring link into this workspace, or
 * (created by an administrator) into the tenant alone. The
 * token rides the URL's fragment, which a browser never sends to a server or
 * puts in a Referer; the link itself is the secret, so it is shown once.
 */
export const invitationLinkResponseSchema = z
  .object({ url: z.string().url(), expiresAt: z.string() })
  .strict()

/**
 * Why a change was refused. `last_owner`: the product never leaves a
 * workspace without an owner, so its last owner can be neither demoted nor
 * removed. A narrowing of `apiErrorBodySchema`'s `{ error, message }` arm.
 */
export const workspacePeopleRefusalSchema = z
  .object({
    error: z.enum(['not_an_owner', 'unknown_user', 'not_a_member', 'last_owner']),
    message: z.string().min(1),
  })
  .strict()

export type WorkspacePeopleRefusal = z.infer<typeof workspacePeopleRefusalSchema>
