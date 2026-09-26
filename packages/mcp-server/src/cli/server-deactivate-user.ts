import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { createUserDeactivation } from '../server/security/user-deactivation.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import { scanFlags } from './flag-table.js'
import { findNamedUser, type NamedUser } from './named-user.js'
import { type Io, openKeeperDb, processIo, usageError } from './operator-command.js'

export type DeactivateUserOutcome =
  | { kind: 'ok'; user: NamedUser; deactivated: boolean; changed: boolean }
  | { kind: 'unknown-user' | 'ambiguous-user'; users: NamedUser[] }

/**
 * ADR-0049 decision 4: the operator deactivates a user, or with `reactivate`
 * reverses it, from the machine that holds the data. Nothing the user owns
 * is removed; their sessions end.
 */
export async function deactivateUser(
  db: TenantDatabase,
  { user, reactivate, now }: { user: string; reactivate: boolean; now: number },
): Promise<DeactivateUserOutcome> {
  const found = await findNamedUser(createMemberProfileStore(db), user)
  if (found.kind !== 'found') return found
  const deactivation = createUserDeactivation(db)
  const changed = reactivate
    ? await deactivation.reactivate(found.user.id)
    : await deactivation.deactivate(found.user.id, now)
  return { kind: 'ok', user: found.user, deactivated: !reactivate, changed }
}

const USAGE =
  'Re-run with: whiteboard server deactivate-user --json --user=<id|name> [--reactivate] [--data-dir=<path>]'

const REFUSAL: Record<Exclude<DeactivateUserOutcome['kind'], 'ok'>, string> = {
  'unknown-user': 'refused: no user by that id or name; the users there are listed on stdout.',
  'ambiguous-user':
    'refused: more than one user has that name. Re-run with --user=<id>; the candidates are listed on stdout.',
}

/** `whiteboard server deactivate-user`: stdout is the outcome as one JSON line. */
export async function runServerDeactivateUser(
  args: readonly string[],
  io: Io = processIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scan = scanFlags(args, {
    booleans: ['--json', '--reactivate'],
    values: { '--user': 'user', '--data-dir': 'dataDir' },
  })
  if (scan.kind === 'usage-error') return usageError(io, scan.message)
  const { user, dataDir } = scan.values
  if (!scan.seen.has('--json')) return usageError(io, `Only --json is supported for now. ${USAGE}`)
  if (user === undefined) return usageError(io, `--user=<id|name> is required. ${USAGE}`)

  const outcome = await deactivateUser(await openKeeperDb(dataDir, env), {
    user,
    reactivate: scan.seen.has('--reactivate'),
    now: Date.now(),
  })
  io.stdout(`${JSON.stringify(outcome)}\n`)
  if (outcome.kind === 'ok') return 0
  io.stderr(`${REFUSAL[outcome.kind]}\n`)
  return 1
}
