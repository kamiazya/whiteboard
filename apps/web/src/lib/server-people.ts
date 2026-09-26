/**
 * ADR-0049 on a server-mode keeper: the calls behind its people screens —
 * a tenant's users as its administrators manage them, and a workspace's
 * people as its owners manage them. Each answer is parsed with the keeper's
 * own contract; a refusal comes back as the sentence the keeper wrote for it.
 */
import {
  administratorResponseSchema,
  deactivationResponseSchema,
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

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

export type TenantPerson = z.infer<typeof tenantPeopleResponseSchema>['people'][number]
export type WorkspacePerson = z.infer<typeof workspacePersonSchema>
export type InvitationLink = z.infer<typeof invitationLinkResponseSchema>

const UNREACHABLE = 'Could not reach the server. Try again.'
const UNEXPECTED = 'The server answered in a way this page does not understand.'

function refusalMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message
  return typeof message === 'string' && message !== '' ? message : 'That was refused.'
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
  if (!res.ok) return { ok: false, message: refusalMessage(body) }
  const parsed = schema.safeParse(body)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: UNEXPECTED }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const person = (userId: string) => `/api/people/${encodeURIComponent(userId)}`
const workspace = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}`

export const tenantPeople = {
  list: (fetchFn: Fetch) => call(fetchFn, '/api/people', tenantPeopleResponseSchema),
  setDeactivated: (fetchFn: Fetch, userId: string, deactivated: boolean) =>
    call(fetchFn, `${person(userId)}/deactivation`, deactivationResponseSchema, {
      method: deactivated ? 'POST' : 'DELETE',
    }),
  setAdministrator: (fetchFn: Fetch, userId: string, administrator: boolean) =>
    call(fetchFn, `${person(userId)}/administrator`, administratorResponseSchema, {
      method: administrator ? 'PUT' : 'DELETE',
    }),
  invite: (fetchFn: Fetch) =>
    call(fetchFn, '/api/invitations', invitationLinkResponseSchema, json('POST', {})),
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
