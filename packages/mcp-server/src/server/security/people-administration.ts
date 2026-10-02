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
import type { AdministratorCheck } from './administrator-check.js'
import type { ResolvedGrant } from './credential-resolver.js'
import type { MemberProfileStore } from './member-profile-store.js'
import type { TenantAdministratorStore } from './tenant-administrator-store.js'
import type { UserDeactivation } from './user-deactivation.js'
import type { UserDeletion } from './user-deletion.js'

type RefusalReason = TenantPeopleRefusal['error']

export interface Refused<R extends RefusalReason> {
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
    readonly appointments: Pick<TenantAdministratorStore, 'appoint' | 'dismiss'>
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
      if (at === null || now - at > ADMINISTRATION_WINDOW_MS) {
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
    Done<{ readonly changed: boolean }> | Refused<'unknown_user' | 'cannot_deactivate_self'>
  >
  /** `changed` is false when they were not deactivated. */
  reactivate(userId: string): Promise<Done<{ readonly changed: boolean }> | Refused<'unknown_user'>>
  appoint(userId: string, by: By): Promise<Done | Refused<'unknown_user'>>
  dismiss(userId: string, by: By): Promise<Done | Refused<'unknown_user' | 'cannot_dismiss_self'>>
}

export function createPeopleAdministration(deps: {
  readonly members: Pick<MemberProfileStore, 'listUsers'>
  readonly appointments: Pick<TenantAdministratorStore, 'appoint' | 'dismiss'>
  readonly deactivation: UserDeactivation
}): PeopleAdministration {
  const isUser = async (userId: string) =>
    (await deps.members.listUsers()).some((user) => user.id === userId)
  const unknown = { kind: 'refused', reason: 'unknown_user' } as const

  return {
    async deactivate(userId, by, now) {
      if (!(await isUser(userId))) return unknown
      if (userId === by) return { kind: 'refused', reason: 'cannot_deactivate_self' }
      return { kind: 'done', changed: await deps.deactivation.deactivate(userId, now) }
    },

    async reactivate(userId) {
      if (!(await isUser(userId))) return unknown
      return { kind: 'done', changed: await deps.deactivation.reactivate(userId) }
    },

    async appoint(userId, by) {
      if (!(await isUser(userId))) return unknown
      await deps.appointments.appoint(userId, by)
      return { kind: 'done' }
    },

    async dismiss(userId, by) {
      if (!(await isUser(userId))) return unknown
      if (userId === by) return { kind: 'refused', reason: 'cannot_dismiss_self' }
      await deps.appointments.dismiss(userId)
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
): Promise<Done | Refused<'unknown_user' | 'not_deactivated'> | SoleOwner> {
  const outcome = await deletion.delete(userId)
  switch (outcome.kind) {
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
