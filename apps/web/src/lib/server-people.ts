/**
 * ADR-0049 on a server-mode keeper: the calls behind its people screens —
 * a tenant's users as its administrators manage them, and a workspace's
 * people as its owners manage them. Each answer is parsed with the keeper's
 * own contract; a refusal comes back as the sentence the keeper wrote for it.
 */
import {
  administratorResponseSchema,
  deactivationResponseSchema,
  deletionResponseSchema,
  tenantPeopleResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/tenant-people'
import {
  invitationLinkResponseSchema,
  removeWorkspacePersonResponseSchema,
  workspacePeopleResponseSchema,
  workspacePersonSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import type { z } from 'zod'

type Fetch = typeof globalThis.fetch

/** A refusal in the keeper's words; `reauthenticate` when it asked for a
 *  recent sign-in at the provider before an administrator acts (ADR-0051). */
export type Refused = {
  readonly ok: false
  readonly message: string
  readonly reauthenticate?: true
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | Refused

export type TenantPerson = z.infer<typeof tenantPeopleResponseSchema>['people'][number]
export type WorkspacePerson = z.infer<typeof workspacePersonSchema>
export type InvitationLink = z.infer<typeof invitationLinkResponseSchema>

const UNREACHABLE = 'Could not reach the server. Try again.'
const UNEXPECTED = 'The server answered in a way this page does not understand.'

function refusal(body: unknown): Refused {
  const { message, error, workspaceIds } = (body ?? {}) as {
    message?: unknown
    error?: unknown
    workspaceIds?: unknown
  }
  const said = typeof message === 'string' && message !== '' ? message : 'That was refused.'
  // ADR-0051: a sole owner's deletion is refused naming the workspaces.
  const named = Array.isArray(workspaceIds) ? `${said}: ${workspaceIds.join(', ')}` : said
  return {
    ok: false,
    message: named,
    ...(error === 'reauthentication_required' ? { reauthenticate: true } : {}),
  }
}

async function call<S extends z.ZodTypeAny>(
  fetchFn: Fetch,
  url: string,
  schema: S,
  init?: RequestInit,
): Promise<Outcome<z.infer<S>>> {
  const res = await fetchFn(url, init).catch(() => null)
  if (res === null) return { ok: false, message: UNREACHABLE }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) return refusal(body)
  const parsed = schema.safeParse(body)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: UNEXPECTED }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const workspace = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}`

export const tenantPeople = {
  list: (fetchFn: Fetch) => call(fetchFn, '/api/people', tenantPeopleResponseSchema),
  setDeactivated: (fetchFn: Fetch, userId: string, deactivated: boolean) =>
    call(
      fetchFn,
      `/api/people/${encodeURIComponent(userId)}/deactivation`,
      deactivationResponseSchema,
      {
        method: deactivated ? 'POST' : 'DELETE',
      },
    ),
  setAdministrator: (fetchFn: Fetch, userId: string, administrator: boolean) =>
    call(
      fetchFn,
      `/api/people/${encodeURIComponent(userId)}/administrator`,
      administratorResponseSchema,
      {
        method: administrator ? 'PUT' : 'DELETE',
      },
    ),
  invite: (fetchFn: Fetch) =>
    call(fetchFn, '/api/invitations', invitationLinkResponseSchema, json('POST', {})),
  delete: (fetchFn: Fetch, userId: string) =>
    call(fetchFn, `/api/people/${encodeURIComponent(userId)}`, deletionResponseSchema, {
      method: 'DELETE',
    }),
}

export const workspacePeople = {
  list: (fetchFn: Fetch, workspaceId: string) =>
    call(fetchFn, `${workspace(workspaceId)}/people`, workspacePeopleResponseSchema),
  setRole: (fetchFn: Fetch, workspaceId: string, userId: string, role: WorkspacePerson['role']) =>
    call(
      fetchFn,
      `${workspace(workspaceId)}/people/${encodeURIComponent(userId)}`,
      workspacePersonSchema,
      json('PATCH', { role }),
    ),
  remove: (fetchFn: Fetch, workspaceId: string, userId: string) =>
    call(
      fetchFn,
      `${workspace(workspaceId)}/people/${encodeURIComponent(userId)}`,
      removeWorkspacePersonResponseSchema,
      { method: 'DELETE' },
    ),
  invite: (fetchFn: Fetch, workspaceId: string) =>
    call(
      fetchFn,
      `${workspace(workspaceId)}/invitations`,
      invitationLinkResponseSchema,
      json('POST', {}),
    ),
}
