import type { AnyRefusal } from '../server/security/people-administration.js'
import { providerAuthenticator, type SignInProvider } from '../server/security/sign-in-config.js'
import { readSignInProviders, SIGN_IN_CONFIG_ENV } from '../server/security/sign-in-config-file.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import type { BoundUser } from './operator-json.js'

/**
 * How an operator names a user: by the user id, or by the provider and the
 * subject that provider knows them by — the binding `server add-user` takes.
 * Never by display name: that is whatever the person's provider claimed at
 * first sign-in, so the first newcomer to call themselves "Alice" would be
 * the Alice an operator appointed or granted.
 */
export type UserReference =
  | { kind: 'id'; id: string }
  | { kind: 'binding'; provider: string; subject: string }

export type NamedUserLookup =
  | { kind: 'found'; user: BoundUser }
  | { kind: 'unknown-user'; users: BoundUser[] }
  | { kind: 'unknown-provider'; providers: string[] }

/** The flags that name a user, as every user-naming command takes them. */
export const USER_REFERENCE_FLAGS = {
  '--user': 'user',
  '--provider': 'provider',
  '--subject': 'subject',
} as const

export const USER_REFERENCE_USAGE = '(--user=<user id> | --provider=<id> --subject=<sub>)'

/** The reference the flags spell, or why they spell none. */
export function readUserReference(values: {
  user?: string
  provider?: string
  subject?: string
}): { kind: 'ok'; reference: UserReference } | { kind: 'usage-error'; message: string } {
  const { user, provider, subject } = values
  const byBinding = provider !== undefined || subject !== undefined
  if (user !== undefined && byBinding) {
    return {
      kind: 'usage-error',
      message: '--user and --provider/--subject name a user two ways; give one.',
    }
  }
  if (user !== undefined) return { kind: 'ok', reference: { kind: 'id', id: user } }
  if (provider !== undefined && subject !== undefined) {
    return { kind: 'ok', reference: { kind: 'binding', provider, subject } }
  }
  if (byBinding) {
    return { kind: 'usage-error', message: '--provider and --subject are given together.' }
  }
  return { kind: 'usage-error', message: `${USER_REFERENCE_USAGE} is required.` }
}

/** The providers the keeper's sign-in configuration declares, if it has one. */
export function configuredProviders(env: NodeJS.ProcessEnv): SignInProvider[] {
  const path = env[SIGN_IN_CONFIG_ENV]
  return path === undefined || path === '' ? [] : readSignInProviders(path)
}

/** The refusal line every user-naming command prints for an unknown user. */
export const UNKNOWN_USER_GUIDANCE =
  'no user with that id or binding. Name the person with --user=<user id> or --provider=<id> --subject=<sub>, never a display name; the users there are listed on stdout with their bindings. Someone not listed has to become a user here first — by signing in, by a bearer, or with `whiteboard server add-user`.'

export const UNKNOWN_PROVIDER_GUIDANCE =
  'no provider by that id in the sign-in configuration; those declared are listed on stdout.'

/**
 * Every user of this tenant with the bindings that identify them, oldest
 * first. Deactivated users are included: an operator reactivates them by the
 * same reference.
 */
async function boundUsers(
  db: TenantDatabase,
  providers: readonly SignInProvider[],
): Promise<(BoundUser & { accountId: string })[]> {
  const users = await db
    .selectFrom('memberProfiles')
    .select(['id', 'displayName', 'accountId'])
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute()
  const accountIds = users.map((u) => u.accountId)
  const bindings =
    accountIds.length === 0
      ? []
      : await db
          .selectFrom('accountBindings')
          .select(['accountId', 'authenticator', 'subject'])
          .where('accountId', 'in', accountIds)
          .orderBy('createdAt', 'asc')
          .orderBy('subject', 'asc')
          .execute()
  const providerOf = new Map(providers.map((p) => [providerAuthenticator(p), p.id]))
  return users.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    accountId: u.accountId,
    bindings: bindings
      .filter((b) => b.accountId === u.accountId)
      .map(({ authenticator, subject }) => ({
        provider: providerOf.get(authenticator) ?? null,
        authenticator,
        subject,
      })),
  }))
}

/** The user an operator named, or the candidates when the name reaches nobody. */
export async function findNamedUser(
  db: TenantDatabase,
  reference: UserReference,
  providers: readonly SignInProvider[],
): Promise<NamedUserLookup> {
  let authenticator: string | undefined
  if (reference.kind === 'binding') {
    const provider = providers.find((p) => p.id === reference.provider)
    if (provider === undefined) {
      return { kind: 'unknown-provider', providers: providers.map((p) => p.id) }
    }
    authenticator = providerAuthenticator(provider)
  }
  const users = await boundUsers(db, providers)
  const found = users.find((u) =>
    reference.kind === 'id'
      ? u.id === reference.id
      : u.bindings.some(
          (b) => b.authenticator === authenticator && b.subject === reference.subject,
        ),
  )
  const strip = ({ accountId: _accountId, ...user }: BoundUser & { accountId: string }) => user
  if (found === undefined) return { kind: 'unknown-user', users: users.map(strip) }
  return { kind: 'found', user: strip(found) }
}

/**
 * The operator's outcome for a refusal from the people operation. The user was
 * found a moment ago, so `unknown_user` here means they were deleted in
 * between. The operator is nobody's user, so a refusal about acting on oneself
 * cannot be reached from the command line.
 */
export function operatorRefusal(refusal: AnyRefusal): { kind: 'unknown-user'; users: [] } {
  if (refusal.reason !== 'unknown_user') {
    throw new Error(`the operator cannot be refused as acting on themselves: ${refusal.reason}`)
  }
  return { kind: 'unknown-user', users: [] }
}
