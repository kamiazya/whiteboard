/**
 * ADR-0049 decision 2: whether the person behind a request administers this
 * tenant. Two sources, and neither overwrites the other: the tenant's own
 * appointments, and the administrators the configuration names. The
 * configured list is consulted on every check, so a name removed from it
 * stops counting at that person's next request.
 */
import type { AuthenticatorBinding, MemberProfileStore } from './member-profile-store.js'
import type { TenantAdministratorStore } from './tenant-administrator-store.js'

export interface AdministratorCheck {
  isAdministrator(person: AuthenticatorBinding): Promise<boolean>
  /** Every user who administers this tenant, from either source. */
  administratorIds(): Promise<ReadonlySet<string>>
}

export function createAdministratorCheck(deps: {
  readonly admins: TenantAdministratorStore
  readonly members: Pick<MemberProfileStore, 'profileForBinding' | 'isDeactivated'>
  readonly configured: readonly AuthenticatorBinding[]
}): AdministratorCheck {
  return {
    async isAdministrator(person) {
      const named = deps.configured.some(
        (admin) => admin.authenticator === person.authenticator && admin.subject === person.subject,
      )
      if (named) return !(await deps.members.isDeactivated(person))
      const user = await deps.members.profileForBinding(person)
      return user !== null && (await deps.admins.isAppointed(user.id))
    },

    async administratorIds() {
      const ids = new Set((await deps.admins.list()).map((a) => a.profileId))
      for (const person of deps.configured) {
        const user = await deps.members.profileForBinding(person)
        if (user !== null) ids.add(user.id)
      }
      return ids
    },
  }
}
