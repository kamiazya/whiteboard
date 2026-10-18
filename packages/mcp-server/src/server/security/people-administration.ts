/**
 * ADR-0049 decisions 1, 2 and 4 and ADR-0051: what an administrator may do to
 * a tenant's people, as DECISIONS rather than as a route. The HTTP API and the
 * operator's command line both change the same rows, and the rules about who
 * may — not oneself, only a user that exists, only on a recent sign-in, only a
 * deactivated person deleted — live here once, so a surface translates the
 * answer instead of re-deciding it.
 *
 * Every refusal is a value. A caller maps `reason` onto its own vocabulary (a
 * status code, an exit code) and never learns a rule by reimplementing it.
 *
 * The operator at the machine is nobody's user: it passes `null` for who is
 * acting, which no self-refusal can ever match.
 */
import type { TenantPeopleRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/tenant-people'
import type { WorkspacePeopleRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import type { AdministratorCheck } from './administrator-check.js'
import type { ResolvedGrant } from './credential-resolver.js'
import type { MemberProfileStore } from './member-profile-store.js'
import { DEFAULT_CLOCK_SKEW_SECONDS } from './oauth-jwt-validator.js'
import type { TenantAdministratorStore } from './tenant-administrator-store.js'
import type { UserDeactivation } from './user-deactivation.js'
import type { UserDeletion } from './user-deletion.js'
import type { WorkspaceMember, WorkspaceRoles } from './workspace-roles.js'

type RefusalReason = TenantPeopleRefusal['error']
type WorkspaceRefusalReason = WorkspacePeopleRefusal['error']

export interface Refused<R extends RefusalReason | WorkspaceRefusalReason> {
  readonly kind: 'refused'
  readonly reason: R
}

/** A refusal from any of these decisions, for a caller that maps them all. */
export type AnyRefusal = Refused<RefusalReason>

type SoleOwner = Refused<'sole_owner'> & { readonly workspaceIds: readonly string[] }

/**
 * ADR-0051 decision 5: how old a sign-in at the provider may be for an
 * administrator's action. Listing people is not an action and is not gated.
 */
export const ADMINISTRATION_WINDOW_MS = 15 * 60 * 1000

/**
 * How far ahead of this server's clock a sign-in time may be: the drift a
 * token's own time claims are allowed (`oauth-jwt-validator.ts`). A time
 * further ahead is not a sign-in that happened, and would otherwise sit
 * inside the window for as long as it stays in the future.
 */
export const ADMINISTRATION_CLOCK_SKEW_MS = DEFAULT_CLOCK_SKEW_SECONDS * 1000

interface Person {
  readonly userId: string
  readonly displayName: string
  readonly deactivated: boolean
  readonly administrator: boolean
}

type Authorization =
  | { readonly kind: 'authorized'; readonly userId: string }
  | Refused<'not_an_administrator' | 'sign_in_required' | 'reauthentication_required'>

export interface AdministrationAccess {
  /** The acting administrator's user id, or null when the grant is not one's. */
  administratorOf(grant: ResolvedGrant | undefined): Promise<string | null>
  /** Whether this grant may ACT on people now: an administrator, on a sign-in at the provider no older than the window. */
  authorize(grant: ResolvedGrant | undefined, now: number): Promise<Authorization>
  listPeople(): Promise<Person[]>
}

/**
 * What an administration surface is handed to work over: the user list, the
 * administrator check, and the stores a decision acts on.
 */
export interface PeopleAdministrationWiring {
  readonly members: Pick<MemberProfileStore, 'listUsers' | 'profileForBinding'>
  readonly administration: {
    readonly check: AdministratorCheck
    readonly appointments: Pick<
      TenantAdministratorStore,
      'appoint' | 'dismiss' | 'dismissKeepingAnAdministrator'
    >
    readonly deactivation: UserDeactivation
    readonly deletion: UserDeletion
  }
}

export function createAdministrationAccess(deps: {
  readonly members: Pick<MemberProfileStore, 'listUsers' | 'profileForBinding'>
  readonly check: AdministratorCheck
}): AdministrationAccess {
  const administratorOf: AdministrationAccess['administratorOf'] = async (grant) => {
    const person = grant?.person
    if (person === undefined || !(await deps.check.isAdministrator(person))) return null
    return (await deps.members.profileForBinding(person))?.id ?? null
  }

  return {
    administratorOf,

    async authorize(grant, now) {
      const userId = await administratorOf(grant)
      if (userId === null) return { kind: 'refused', reason: 'not_an_administrator' }
      // A bearer has no browser to send back to the provider, so it never may.
      if (grant?.kind !== 'signed-in') return { kind: 'refused', reason: 'sign_in_required' }
      const at = grant.authenticatedAt ?? null
      if (
        at === null ||
        now - at > ADMINISTRATION_WINDOW_MS ||
        at - now > ADMINISTRATION_CLOCK_SKEW_MS
      ) {
        return { kind: 'refused', reason: 'reauthentication_required' }
      }
      return { kind: 'authorized', userId }
    },

    async listPeople() {
      const administrators = await deps.check.administratorIds()
      return (await deps.members.listUsers()).map((user) => ({
        userId: user.id,
        displayName: user.displayName,
        deactivated: user.deactivated,
        // A deactivated administrator cannot act, so is not listed as one.
        administrator: !user.deactivated && administrators.has(user.id),
      }))
    },
  }
}

type Done<T extends object = object> = { readonly kind: 'done' } & T

/** Who is acting: an administrator's user id, or null for the operator. */
type By = string | null

export interface PeopleAdministration {
  /** `changed` is false when they were already deactivated. */
  deactivate(
    userId: string,
    by: By,
    now: number,
  ): Promise<
    | Done<{ readonly changed: boolean }>
    | Refused<
        'unknown_user' | 'cannot_deactivate_self' | 'last_administrator' | 'not_an_administrator'
      >
  >
  /** `changed` is false when they were not deactivated. */
  reactivate(
    userId: string,
    by: By,
  ): Promise<Done<{ readonly changed: boolean }> | Refused<'unknown_user' | 'not_an_administrator'>>
  appoint(userId: string, by: By): Promise<Done | Refused<'unknown_user' | 'not_an_administrator'>>
  dismiss(
    userId: string,
    by: By,
  ): Promise<Done | Refused<'unknown_user' | 'cannot_dismiss_self' | 'not_an_administrator'>>
}

interface PeopleAdministrationDeps {
  readonly members: Pick<MemberProfileStore, 'listUsers'>
  readonly appointments: Pick<
    TenantAdministratorStore,
    'appoint' | 'dismiss' | 'dismissKeepingAnAdministrator'
  >
  readonly deactivation: UserDeactivation
}

// The request was authorized before the change; by the time the change ran
// the actor had been dismissed or deactivated.
const NOT_AN_ADMINISTRATOR = { kind: 'refused', reason: 'not_an_administrator' } as const

function answerDeactivation(
  outcome: Awaited<ReturnType<UserDeactivation['deactivateKeepingAnAdministrator']>>,
) {
  if (outcome === 'last-administrator') {
    return { kind: 'refused', reason: 'last_administrator' } as const
  }
  if (outcome === 'not-an-administrator') return NOT_AN_ADMINISTRATOR
  return { kind: 'done', changed: outcome === 'deactivated' } as const
}

export function createPeopleAdministration(deps: PeopleAdministrationDeps): PeopleAdministration {
  const isUser = async (userId: string) =>
    (await deps.members.listUsers()).some((user) => user.id === userId)
  const unknown = { kind: 'refused', reason: 'unknown_user' } as const

  return {
    async deactivate(userId, by, now) {
      if (!(await isUser(userId))) return unknown
      if (userId === by) return { kind: 'refused', reason: 'cannot_deactivate_self' }
      // The operator can appoint another from the command line; an
      // administrator's request must not leave the tenant with none.
      if (by === null) {
        return { kind: 'done', changed: await deps.deactivation.deactivate(userId, now) }
      }
      return answerDeactivation(
        await deps.deactivation.deactivateKeepingAnAdministrator(userId, now, by),
      )
    },

    async reactivate(userId, by) {
      if (!(await isUser(userId))) return unknown
      if (by === null) {
        return { kind: 'done', changed: await deps.deactivation.reactivate(userId) }
      }
      const outcome = await deps.deactivation.reactivateAsAdministrator(userId, by)
      if (outcome === 'not-an-administrator') return NOT_AN_ADMINISTRATOR
      return { kind: 'done', changed: outcome === 'reactivated' }
    },

    async appoint(userId, by) {
      if (!(await isUser(userId))) return unknown
      const outcome = await deps.appointments.appoint(userId, by)
      return outcome === 'not-an-administrator' ? NOT_AN_ADMINISTRATOR : { kind: 'done' }
    },

    async dismiss(userId, by) {
      if (!(await isUser(userId))) return unknown
      if (userId === by) return { kind: 'refused', reason: 'cannot_dismiss_self' }
      if (by === null) {
        await deps.appointments.dismiss(userId)
        return { kind: 'done' }
      }
      const outcome = await deps.appointments.dismissKeepingAnAdministrator(userId, by)
      return outcome === 'not-an-administrator' ? NOT_AN_ADMINISTRATOR : { kind: 'done' }
    },
  }
}

type WorkspaceRole = WorkspaceMember['role']

/**
 * What may be done to one workspace's people. WHETHER a caller may — an owner
 * of this workspace, or the operator at the machine — is the keeper's
 * authority and the surface asks it first; each change then names who is
 * acting (`by`, null for the operator) and is refused `not_an_owner` when that
 * owner stopped owning the workspace between the two. The rest are the rules
 * about the people themselves, written once for the HTTP route and the
 * operator's command line.
 */
export interface WorkspacePeopleAdministration {
  /** Admits a user as a member; a workspace's first member is its owner. */
  add(
    workspaceId: string,
    userId: string,
    by: By,
  ): Promise<Done | Refused<'unknown_user' | 'not_an_owner'>>
  /** The product never leaves a workspace without an owner (ADR-0049). */
  changeRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
    by: By,
  ): Promise<Done | Refused<'not_a_member' | 'last_owner' | 'not_an_owner'>>
  remove(
    workspaceId: string,
    userId: string,
    by: By,
  ): Promise<Done | Refused<'not_a_member' | 'last_owner' | 'not_an_owner'>>
  /**
   * The operator admits a person, and when no active owner is left makes them
   * the owner: a member could not manage the people of the workspace this was
   * run to recover (ADR-0049).
   */
  grant(workspaceId: string, userId: string): Promise<Done | Refused<'unknown_user'>>
}

const WORKSPACE_REFUSALS = {
  'not-a-member': 'not_a_member',
  'last-owner': 'last_owner',
  'not-an-owner': 'not_an_owner',
} as const

export function createWorkspacePeopleAdministration(deps: {
  readonly members: Pick<MemberProfileStore, 'addMember'>
  readonly roles: WorkspaceRoles
}): WorkspacePeopleAdministration {
  const { members, roles } = deps
  const answer = (change: Awaited<ReturnType<WorkspaceRoles['setRole']>>) =>
    change === 'ok'
      ? ({ kind: 'done' } as const)
      : ({ kind: 'refused', reason: WORKSPACE_REFUSALS[change] } as const)

  return {
    async add(workspaceId, userId, by) {
      if (!(await roles.isUser(userId))) return { kind: 'refused', reason: 'unknown_user' }
      if (by === null) {
        await members.addMember(workspaceId, userId)
        return { kind: 'done' }
      }
      const added = await roles.addAsOwner(workspaceId, userId, by)
      return added === 'ok' ? { kind: 'done' } : { kind: 'refused', reason: 'not_an_owner' }
    },

    async changeRole(workspaceId, userId, role, by) {
      return answer(
        by === null
          ? await roles.setRole(workspaceId, userId, role)
          : await roles.setRoleAsOwner(workspaceId, userId, role, by),
      )
    },

    async remove(workspaceId, userId, by) {
      return answer(
        by === null
          ? await roles.remove(workspaceId, userId)
          : await roles.removeAsOwner(workspaceId, userId, by),
      )
    },

    async grant(workspaceId, userId) {
      if (!(await roles.isUser(userId))) return { kind: 'refused', reason: 'unknown_user' }
      await members.addMember(workspaceId, userId)
      const owned = (await roles.list(workspaceId)).some(
        (member) => member.role === 'owner' && !member.deactivated,
      )
      if (!owned) await roles.setRole(workspaceId, userId, 'owner')
      return { kind: 'done' }
    },
  }
}

/**
 * ADR-0051: deleting is final, so it asks for deactivation first and never
 * leaves a workspace without an owner. The store decides each in one
 * transaction; this names what it found.
 */
export async function deletePerson(
  deletion: UserDeletion,
  userId: string,
  by: By,
): Promise<
  Done | Refused<'unknown_user' | 'not_deactivated' | 'not_an_administrator'> | SoleOwner
> {
  const outcome = await deletion.delete(userId, by)
  switch (outcome.kind) {
    case 'not-an-administrator':
      return NOT_AN_ADMINISTRATOR
    case 'deleted':
      return { kind: 'done' }
    case 'unknown-user':
      return { kind: 'refused', reason: 'unknown_user' }
    case 'not-deactivated':
      return { kind: 'refused', reason: 'not_deactivated' }
    case 'sole-owner':
      return { kind: 'refused', reason: 'sole_owner', workspaceIds: outcome.workspaceIds }
  }
}
