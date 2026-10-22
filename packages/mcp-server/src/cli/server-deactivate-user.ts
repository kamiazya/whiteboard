import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { createPeopleAdministration } from '../server/security/people-administration.js'
import type { SignInProvider } from '../server/security/sign-in-config.js'
import { createTenantAdministratorStore } from '../server/security/tenant-administrator-store.js'
import { createUserDeactivation } from '../server/security/user-deactivation.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import { scanFlags } from './flag-table.js'
import {
  configuredProviders,
  findNamedUser,
  operatorRefusal,
  readUserReference,
  UNKNOWN_PROVIDER_GUIDANCE,
  UNKNOWN_USER_GUIDANCE,
  USER_REFERENCE_FLAGS,
  USER_REFERENCE_USAGE,
  type UserReference,
} from './named-user.js'
import { type Io, openKeeperDb, processIo, usageError } from './operator-command.js'
import {
  type DeactivateUserOutput,
  deactivateUserOutputSchema,
  OPERATOR_JSON_SCHEMA_VERSION,
  operatorJsonLine,
  type WithoutSchemaVersion,
} from './operator-json.js'

export type DeactivateUserOutcome = WithoutSchemaVersion<DeactivateUserOutput>

/**
 * ADR-0049 decision 4: the operator deactivates a user, or with `reactivate`
 * reverses it, from the machine that holds the data. Nothing the user owns
 * is removed; their sessions end.
 */
export async function deactivateUser(
  db: TenantDatabase,
  {
    user,
    reactivate,
    now,
    providers = [],
  }: {
    user: UserReference
    reactivate: boolean
    now: number
    providers?: readonly SignInProvider[]
  },
): Promise<DeactivateUserOutcome> {
  const members = createMemberProfileStore(db)
  const found = await findNamedUser(db, user, providers)
  if (found.kind !== 'found') return found
  const people = createPeopleAdministration({
    members,
    appointments: createTenantAdministratorStore(db),
    deactivation: createUserDeactivation(db),
  })
  // The operator deactivates as nobody's user, so no self-refusal applies.
  const outcome = reactivate
    ? await people.reactivate(found.user.id, null)
    : await people.deactivate(found.user.id, null, now)
  if (outcome.kind === 'refused') return operatorRefusal(outcome)
  return { kind: 'ok', user: found.user, deactivated: !reactivate, changed: outcome.changed }
}

const USAGE = `Re-run with: whiteboard server deactivate-user --json ${USER_REFERENCE_USAGE} [--reactivate] [--data-dir=<path>]`

const REFUSAL: Record<Exclude<DeactivateUserOutcome['kind'], 'ok'>, string> = {
  'unknown-user': `refused: ${UNKNOWN_USER_GUIDANCE}`,
  'unknown-provider': `refused: ${UNKNOWN_PROVIDER_GUIDANCE}`,
}

/** `whiteboard server deactivate-user`: stdout is the outcome as one JSON line. */
export async function runServerDeactivateUser(
  args: readonly string[],
  io: Io = processIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scan = scanFlags(args, {
    booleans: ['--json', '--reactivate'],
    values: { ...USER_REFERENCE_FLAGS, '--data-dir': 'dataDir' },
  })
  if (scan.kind === 'usage-error') return usageError(io, scan.message)
  const { dataDir } = scan.values
  if (!scan.seen.has('--json')) return usageError(io, `Only --json is supported for now. ${USAGE}`)
  const reference = readUserReference(scan.values)
  if (reference.kind === 'usage-error') return usageError(io, `${reference.message} ${USAGE}`)
  const providers = configuredProviders(env, reference.reference)
  if (providers.kind === 'usage-error') return usageError(io, providers.message)

  const outcome = await deactivateUser(await openKeeperDb(dataDir, env), {
    user: reference.reference,
    providers: providers.providers,
    reactivate: scan.seen.has('--reactivate'),
    now: Date.now(),
  })
  io.stdout(
    operatorJsonLine(deactivateUserOutputSchema, {
      schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
      ...outcome,
    }),
  )
  if (outcome.kind === 'ok') return 0
  io.stderr(`${REFUSAL[outcome.kind]}\n`)
  return 1
}
