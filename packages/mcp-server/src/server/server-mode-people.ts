import { createAdministratorCheck } from './security/administrator-check.js'
import { type CompleteSignInDeps, createCompleteSignInDeps } from './security/complete-sign-in.js'
import type { AuthenticatorBinding } from './security/member-profile-store.js'
import type { ServerModePeople } from './security/server-mode-middleware.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createUserDeactivation } from './security/user-deactivation.js'
import { createUserDeletion } from './security/user-deletion.js'
import { createWorkspaceRoles } from './security/workspace-roles.js'
import { accountRetirementFor } from './store/db/account-retirement.js'
import { getDb } from './store/db/index.js'
import type { TenantDatabase } from './store/db/tenant-database.js'

// How long a sign-in lasts before the person signs in again. Admission is
// re-checked at that sign-in (ADR-0046 decision 5); membership is checked on
// every request regardless, so this bounds only how stale a REFUSAL can be.
const SIGN_IN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ServerModePeopleOptions {
  readonly dataDir: string
  readonly publicBaseUrl: string
  /** ADR-0049 decision 2: the administrators the sign-in configuration names. */
  readonly configuredAdministrators?: readonly AuthenticatorBinding[]
}

/**
 * The `people` server mode's `createApp` requires, built over one tenant
 * database the way the root builds it. It is the ONE definition: a test
 * composition and the packaged smoke call it too, so none of the three can
 * wire a different set of stores and read as the real thing. `signIn` is the
 * deps the sign-in routes complete a sign-in with; it shares the member,
 * session and invitation stores with `people`, which is what lets a session
 * minted at sign-in be honoured by the membership gate.
 */
export function createServerModePeople(
  db: TenantDatabase,
  options: ServerModePeopleOptions,
): { people: ServerModePeople; signIn: CompleteSignInDeps } {
  const signIn = createCompleteSignInDeps(db, SIGN_IN_SESSION_TTL_MS)
  const appointments = createTenantAdministratorStore(db)
  const people: ServerModePeople = {
    members: signIn.members,
    sessions: signIn.sessions,
    roles: createWorkspaceRoles(db),
    invitations: signIn.invitations,
    administration: {
      check: createAdministratorCheck({
        admins: appointments,
        members: signIn.members,
        configured: options.configuredAdministrators ?? [],
      }),
      appointments,
      deactivation: createUserDeactivation(db),
      deletion: createUserDeletion(db, accountRetirementFor(options.dataDir)),
    },
    origin: new URL(options.publicBaseUrl).origin,
  }
  return { people, signIn }
}

/** The same over the tenant database at `dataDir`, handing the database back
 *  for the routes that need it beside `people`. */
export async function openServerModePeople(
  options: ServerModePeopleOptions,
): Promise<{ db: TenantDatabase; people: ServerModePeople; signIn: CompleteSignInDeps }> {
  const db = await getDb(options.dataDir)
  return { db, ...createServerModePeople(db, options) }
}
