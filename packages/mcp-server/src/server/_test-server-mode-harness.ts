// What a server-mode `createApp` needs to mount the people routers, for the
// tests that drive server mode's whole `/api` rather than one router: a bearer
// that names its own subject, and the people stores over one tenant database.
// Test support only — production composes these in `di/`.

import type { SignInRoutesDeps } from './routes/sign-in.js'
import { oidcProviders, resolvedForTest } from './security/_test-helpers.js'
import { createAdministratorCheck } from './security/administrator-check.js'
import { ALL_AUTH_SCOPES } from './security/auth-strategy.js'
import { createCompleteSignInDeps } from './security/complete-sign-in.js'
import { createInvitationStore } from './security/invitation-store.js'
import {
  createMemberProfileStore,
  type MemberProfileStore,
} from './security/member-profile-store.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import type { RelyingParty } from './security/oidc-relying-party.js'
import { createSignInAttemptStore } from './security/sign-in-attempt-store.js'
import { signInConfigSchema } from './security/sign-in-config.js'
import {
  createSignInSessionStore,
  type SignInSessionStore,
} from './security/sign-in-session-store.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createUserDeactivation } from './security/user-deactivation.js'
import { createUserDeletion } from './security/user-deletion.js'
import { createWorkspaceRoles } from './security/workspace-roles.js'
import { accountRetirementFor } from './store/db/account-retirement.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

/** The OIDC provider server-mode tests sign in through. */
export const IDP = 'https://idp.test'
export const ISSUER = 'oidc:https://idp.test'
export const PUBLIC_URL = 'https://example.com'

export const bearerNamesItsSubject: AsyncAuthStrategy = {
  async authorize({ authorizationHeader }) {
    const sub = authorizationHeader?.replace(/^Bearer /, '')
    if (!sub) return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
    return {
      ok: true,
      context: {
        kind: 'oauth-resource-server',
        subject: sub,
        scopes: ALL_AUTH_SCOPES,
      },
      person: { authenticator: ISSUER, subject: sub },
    }
  },
}

type TenantDb = Awaited<ReturnType<typeof createIsolatedDb>>['db']

/** The people stores and the `people` option server mode's `createApp` takes, over one database. */
export function serverModePeople(db: TenantDb, dataDir: string) {
  const members: MemberProfileStore = createMemberProfileStore(db)
  const sessions: SignInSessionStore = createSignInSessionStore(db)
  const people = {
    members,
    sessions,
    roles: createWorkspaceRoles(db),
    invitations: createInvitationStore(db),
    administration: {
      check: createAdministratorCheck({
        admins: createTenantAdministratorStore(db),
        members: createMemberProfileStore(db),
        configured: [],
      }),
      appointments: createTenantAdministratorStore(db),
      deactivation: createUserDeactivation(db),
      deletion: createUserDeletion(db, accountRetirementFor(dataDir)),
    },
    origin: PUBLIC_URL,
  }
  return { members, sessions, people }
}

/**
 * The `people` option over a throwaway database, for a composition that only
 * needs server mode to be wired the way the root wires it — `people` is
 * required of `ServerModeAppOptions`, so none can leave it out. Dispose when
 * the suite ends.
 */
export async function isolatedServerModePeople(dataDir: string) {
  const handle = await createIsolatedDb({ dataDir })
  return { people: serverModePeople(handle.db, dataDir).people, dispose: () => handle.dispose() }
}

/**
 * The `signIn` option server mode's `createApp` takes, which is what mounts
 * the `/auth` routes (ADR-0046): one OIDC provider, `corp`, over `db`. The
 * relying party is the caller's, since a test that only needs the routes
 * mounted has no provider to talk to.
 */
export function serverModeSignIn(db: TenantDb, rp: RelyingParty): SignInRoutesDeps {
  const signIn = createCompleteSignInDeps(db, 60 * 60 * 1000)
  const providers = oidcProviders(
    signInConfigSchema.parse({
      providers: [
        {
          id: 'corp',
          kind: 'oidc',
          issuer: IDP,
          clientId: 'wb',
          clientSecret: { env: 'CORP_SECRET' },
        },
      ],
    }).providers,
  )
  return {
    providers: providers.map(resolvedForTest),
    rp,
    attempts: createSignInAttemptStore(db),
    signIn,
    administrators: createAdministratorCheck({
      admins: createTenantAdministratorStore(db),
      members: signIn.members,
      configured: [],
    }),
    publicBaseUrl: PUBLIC_URL,
  }
}
