// What a server-mode `createApp` needs to mount the people routers, for the
// tests that drive server mode's whole `/api` rather than one router: a bearer
// that names its own subject, and the people stores over one tenant database.
// Test support only — production composes these in `di/`.

import type { SignInRoutesDeps } from './routes/sign-in.js'
import { oidcProviders, resolvedForTest } from './security/_test-helpers.js'
import { createAdministratorCheck } from './security/administrator-check.js'
import { ALL_AUTH_SCOPES } from './security/auth-strategy.js'
import { createCompleteSignInDeps } from './security/complete-sign-in.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import type { RelyingParty } from './security/oidc-relying-party.js'
import { createSignInAttemptStore } from './security/sign-in-attempt-store.js'
import { signInConfigSchema } from './security/sign-in-config.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createServerModePeople } from './server-mode-people.js'
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
  const { people, signIn } = createServerModePeople(db, { dataDir, publicBaseUrl: PUBLIC_URL })
  return { members: signIn.members, sessions: signIn.sessions, people }
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
