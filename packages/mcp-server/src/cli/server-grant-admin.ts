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
  type GrantAdminOutput,
  grantAdminOutputSchema,
  OPERATOR_JSON_SCHEMA_VERSION,
  operatorJsonLine,
  type WithoutSchemaVersion,
} from './operator-json.js'

export type GrantAdminOutcome = WithoutSchemaVersion<GrantAdminOutput>

/**
 * ADR-0049 decision 2: the operator appoints a tenant's first administrator
 * from the machine that holds its data, the same trust `grant-member` rests
 * on; administrators appoint the rest from inside the product. `remove`
 * dismisses an appointment. It cannot touch an administrator the
 * configuration names, since that list is not stored.
 */
export async function grantAdmin(
  db: TenantDatabase,
  {
    user,
    remove,
    providers = [],
  }: { user: UserReference; remove: boolean; providers?: readonly SignInProvider[] },
): Promise<GrantAdminOutcome> {
  const members = createMemberProfileStore(db)
  const found = await findNamedUser(db, user, providers)
  if (found.kind !== 'found') return found
  const people = createPeopleAdministration({
    members,
    appointments: createTenantAdministratorStore(db),
    deactivation: createUserDeactivation(db),
  })
  // The operator appoints and dismisses as nobody's user.
  const outcome = remove
    ? await people.dismiss(found.user.id, null)
    : await people.appoint(found.user.id, null)
  if (outcome.kind === 'refused') return operatorRefusal(outcome)
  return { kind: 'ok', user: found.user, administrator: !remove }
}

const USAGE = `Re-run with: whiteboard server grant-admin --json ${USER_REFERENCE_USAGE} [--remove] [--data-dir=<path>]`

const REFUSAL: Record<Exclude<GrantAdminOutcome['kind'], 'ok'>, string> = {
  'unknown-user': `grant refused: ${UNKNOWN_USER_GUIDANCE}`,
  'unknown-provider': `grant refused: ${UNKNOWN_PROVIDER_GUIDANCE}`,
}

/** `whiteboard server grant-admin`: stdout is the outcome as one JSON line. */
export async function runServerGrantAdmin(
  args: readonly string[],
  io: Io = processIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scan = scanFlags(args, {
    booleans: ['--json', '--remove'],
    values: { ...USER_REFERENCE_FLAGS, '--data-dir': 'dataDir' },
  })
  if (scan.kind === 'usage-error') return usageError(io, scan.message)
  const { dataDir } = scan.values
  if (!scan.seen.has('--json')) return usageError(io, `Only --json is supported for now. ${USAGE}`)
  const reference = readUserReference(scan.values)
  if (reference.kind === 'usage-error') return usageError(io, `${reference.message} ${USAGE}`)

  const outcome = await grantAdmin(await openKeeperDb(dataDir, env), {
    user: reference.reference,
    providers: configuredProviders(env),
    remove: scan.seen.has('--remove'),
  })
  io.stdout(
    operatorJsonLine(grantAdminOutputSchema, {
      schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
      ...outcome,
    }),
  )
  if (outcome.kind === 'ok') return 0
  io.stderr(`${REFUSAL[outcome.kind]}\n`)
  return 1
}
