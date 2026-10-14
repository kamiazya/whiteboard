/**
 * ADR-0049 on a server-mode keeper: the calls behind its people screens —
 * a tenant's users as its administrators manage them, and a workspace's
 * people as its owners manage them. Each answer is parsed with the keeper's
 * own contract; a refusal comes back as the sentence the keeper wrote for it.
 */
import {
  tenantInvitationsApiUrl,
  tenantPeopleApiUrl,
  tenantPersonAdministratorApiUrl,
  tenantPersonApiUrl,
  tenantPersonDeactivationApiUrl,
  workspaceInvitationsApiUrl,
  workspacePeopleApiUrl,
  workspacePersonApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { apiErrorReason } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { refusalReasonOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/refusal-reason'
import {
  administratorResponseSchema,
  deactivationResponseSchema,
  deletionResponseSchema,
  tenantPeopleRefusalSchema,
  tenantPeopleResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/tenant-people'
import {
  type changeWorkspaceRoleRequestSchema,
  invitationLinkResponseSchema,
  removeWorkspacePersonResponseSchema,
  workspacePeopleRefusalSchema,
  workspacePeopleResponseSchema,
  workspacePersonSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import type { z } from 'zod'
import { DaemonContractError, readDaemonJson } from './daemon-contract-error.js'

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

/** Every refusal either people route writes, read with the schema it was written under. */
const peopleRefusalSchema = tenantPeopleRefusalSchema.or(workspacePeopleRefusalSchema)

function refusal(body: unknown): Refused {
  const parsed = peopleRefusalSchema.safeParse(body)
  // A body neither schema admits still has to become a sentence; it just
  // cannot carry a code this page acts on. A refusal code a newer keeper
  // added still carries its own sentence, which the shared reader finds; a
  // bare 401 or a proxy's HTML carries none.
  if (!parsed.success) return { ok: false, message: apiErrorReason(body) ?? 'That was refused.' }
  const said = parsed.data.message
  // ADR-0051: a sole owner's deletion is refused naming the workspaces.
  const named =
    'workspaceIds' in parsed.data && parsed.data.workspaceIds !== undefined
      ? `${said}: ${parsed.data.workspaceIds.join(', ')}`
      : said
  return {
    ok: false,
    message: named,
    ...(parsed.data.error === 'reauthentication_required' ? { reauthenticate: true } : {}),
  }
}

async function call<T>(
  fetchFn: Fetch,
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<Outcome<T>> {
  const res = await fetchFn(url, init).catch(() => null)
  if (res === null) return { ok: false, message: UNREACHABLE }
  try {
    if (!res.ok) return refusal((await refusalReasonOf(res, '')).body)
    return { ok: true, value: await readDaemonJson(url, res, schema) }
  } catch (err) {
    // The shared readers throw only these two: a drifted answer (already
    // logged), or a body — refusal or success — the network cut off.
    return { ok: false, message: err instanceof DaemonContractError ? UNEXPECTED : UNREACHABLE }
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const tenantPeople = {
  list: (fetchFn: Fetch) => call(fetchFn, tenantPeopleApiUrl(), tenantPeopleResponseSchema),
  setDeactivated: (fetchFn: Fetch, userId: string, deactivated: boolean) =>
    call(fetchFn, tenantPersonDeactivationApiUrl(userId), deactivationResponseSchema, {
      method: deactivated ? 'POST' : 'DELETE',
    }),
  setAdministrator: (fetchFn: Fetch, userId: string, administrator: boolean) =>
    call(fetchFn, tenantPersonAdministratorApiUrl(userId), administratorResponseSchema, {
      method: administrator ? 'PUT' : 'DELETE',
    }),
  invite: (fetchFn: Fetch) =>
    call(fetchFn, tenantInvitationsApiUrl(), invitationLinkResponseSchema, json('POST', {})),
  delete: (fetchFn: Fetch, userId: string) =>
    call(fetchFn, tenantPersonApiUrl(userId), deletionResponseSchema, { method: 'DELETE' }),
}

export const workspacePeople = {
  list: (fetchFn: Fetch, workspaceId: string) =>
    call(fetchFn, workspacePeopleApiUrl(workspaceId), workspacePeopleResponseSchema),
  setRole: (fetchFn: Fetch, workspaceId: string, userId: string, role: WorkspacePerson['role']) =>
    call(
      fetchFn,
      workspacePersonApiUrl(workspaceId, userId),
      workspacePersonSchema,
      json('PATCH', { role } satisfies z.infer<typeof changeWorkspaceRoleRequestSchema>),
    ),
  remove: (fetchFn: Fetch, workspaceId: string, userId: string) =>
    call(fetchFn, workspacePersonApiUrl(workspaceId, userId), removeWorkspacePersonResponseSchema, {
      method: 'DELETE',
    }),
  invite: (fetchFn: Fetch, workspaceId: string) =>
    call(
      fetchFn,
      workspaceInvitationsApiUrl(workspaceId),
      invitationLinkResponseSchema,
      json('POST', {}),
    ),
}
