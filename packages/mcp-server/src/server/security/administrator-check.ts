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
}

export function createAdministratorCheck(deps: {
  readonly admins: TenantAdministratorStore
  readonly members: Pick<MemberProfileStore, 'profileForBinding'>
  readonly configured: readonly AuthenticatorBinding[]
}): AdministratorCheck {
  return {
    async isAdministrator(person) {
      const named = deps.configured.some(
        (admin) => admin.authenticator === person.authenticator && admin.subject === person.subject,
      )
      if (named) return true
      const user = await deps.members.profileForBinding(person)
      return user !== null && (await deps.admins.isAppointed(user.id))
    },
  }
}
