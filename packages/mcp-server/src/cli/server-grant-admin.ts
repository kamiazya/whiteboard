import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { createTenantAdministratorStore } from '../server/security/tenant-administrator-store.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import { scanFlags } from './flag-table.js'
import { findNamedUser, type NamedUser } from './named-user.js'
import { type Io, openKeeperDb, processIo, usageError } from './operator-command.js'

export type GrantAdminOutcome =
  | { kind: 'ok'; user: NamedUser; administrator: boolean }
  | { kind: 'unknown-user' | 'ambiguous-user'; users: NamedUser[] }

/**
 * ADR-0049 decision 2: the operator appoints a tenant's first administrator
 * from the machine that holds its data, the same trust `grant-member` rests
 * on; administrators appoint the rest from inside the product. `remove`
 * dismisses an appointment. It cannot touch an administrator the
 * configuration names, since that list is not stored.
 */
export async function grantAdmin(
  db: TenantDatabase,
  { user, remove }: { user: string; remove: boolean },
): Promise<GrantAdminOutcome> {
  const found = await findNamedUser(createMemberProfileStore(db), user)
  if (found.kind !== 'found') return found
  const admins = createTenantAdministratorStore(db)
  if (remove) await admins.dismiss(found.user.id)
  else await admins.appoint(found.user.id, null)
  return { kind: 'ok', user: found.user, administrator: !remove }
}

const USAGE =
  'Re-run with: whiteboard server grant-admin --json --user=<id|name> [--remove] [--data-dir=<path>]'

const REFUSAL: Record<Exclude<GrantAdminOutcome['kind'], 'ok'>, string> = {
  'unknown-user':
    'grant refused: no user by that id or name. The person has to become a user here first — by signing in, by a bearer, or with `whiteboard server add-user`; the users there are listed on stdout.',
  'ambiguous-user':
    'grant refused: more than one user has that name. Re-run with --user=<id>; the candidates are listed on stdout.',
}

/** `whiteboard server grant-admin`: stdout is the outcome as one JSON line. */
export async function runServerGrantAdmin(
  args: readonly string[],
  io: Io = processIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scan = scanFlags(args, {
    booleans: ['--json', '--remove'],
    values: { '--user': 'user', '--data-dir': 'dataDir' },
  })
  if (scan.kind === 'usage-error') return usageError(io, scan.message)
  const { user, dataDir } = scan.values
  if (!scan.seen.has('--json')) return usageError(io, `Only --json is supported for now. ${USAGE}`)
  if (user === undefined) return usageError(io, `--user=<id|name> is required. ${USAGE}`)

  const outcome = await grantAdmin(await openKeeperDb(dataDir, env), {
    user,
    remove: scan.seen.has('--remove'),
  })
  io.stdout(`${JSON.stringify(outcome)}\n`)
  if (outcome.kind === 'ok') return 0
  io.stderr(`${REFUSAL[outcome.kind]}\n`)
  return 1
}
