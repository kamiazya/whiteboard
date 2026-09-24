import { resolve } from 'node:path'
import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { getDb } from '../server/store/db/index.js'
import { prepareDataDir } from '../server/store/db/prepare.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import { scanFlags } from './flag-table.js'

interface NamedUser {
  id: string
  displayName: string
}

export type GrantMemberOutcome =
  | { kind: 'ok'; workspaceId: string; user: NamedUser }
  | { kind: 'unknown-workspace'; workspaceId: string }
  | { kind: 'unknown-user' | 'ambiguous-user'; users: NamedUser[] }

/**
 * ADR-0046 decision 10: an operator grants a workspace's first member from
 * the machine that holds its data — the party ADR-0041 already trusts to
 * reopen one — so no web surface offers "adopt this workspace" to whoever is
 * signed in. The person must have signed in once, which is what makes them a
 * user here; a name that matches nobody, or more than one, is answered with
 * the candidates rather than a guess.
 */
export async function grantMember(
  db: TenantDatabase,
  { workspaceId: workspaceHandle, user }: { workspaceId: string; user: string },
): Promise<GrantMemberOutcome> {
  // A handle, as every other surface reads one (ADR-0019): the segment an
  // operator sees in a URL, or the canonical id.
  const rows = await db.selectFrom('workspaces').select(['id', 'segment']).execute()
  const workspace = resolveWorkspaceHandle(
    rows.map((row) => ({
      workspaceId: row.id,
      ...(row.segment === null ? {} : { segment: row.segment }),
    })),
    workspaceHandle,
  )
  if (workspace === null) return { kind: 'unknown-workspace', workspaceId: workspaceHandle }
  const { workspaceId } = workspace

  const members = createMemberProfileStore(db)
  const users = await members.listUsers()
  const byId = users.filter((u) => u.id === user)
  const matches = byId.length > 0 ? byId : users.filter((u) => u.displayName === user)
  const [only] = matches
  if (only === undefined) return { kind: 'unknown-user', users }
  if (matches.length > 1) return { kind: 'ambiguous-user', users: matches }

  await members.addMember(workspaceId, only.id)
  return { kind: 'ok', workspaceId, user: only }
}

const USAGE =
  'Re-run with: whiteboard server grant-member --json --workspace=<id|segment> --user=<id|name> [--data-dir=<path>]'

const REFUSAL: Record<Exclude<GrantMemberOutcome['kind'], 'ok'>, string> = {
  'unknown-workspace': 'grant refused: this data directory holds no workspace with that id.',
  'unknown-user':
    'grant refused: no user by that id or name. The person has to sign in once to become a user here; those who have are listed on stdout.',
  'ambiguous-user':
    'grant refused: more than one user has that name. Re-run with --user=<id>; the candidates are listed on stdout.',
}

interface Io {
  stdout(text: string): void
  stderr(text: string): void
}

const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}

/** `whiteboard server grant-member`: stdout is the outcome as one JSON line. */
export async function runServerGrantMember(
  args: readonly string[],
  io: Io = processIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scan = scanFlags(args, {
    booleans: ['--json'],
    values: { '--workspace': 'workspaceId', '--user': 'user', '--data-dir': 'dataDir' },
  })
  if (scan.kind === 'usage-error') return usageError(io, scan.message)
  const { workspaceId, user, dataDir } = scan.values
  if (!scan.seen.has('--json')) return usageError(io, `Only --json is supported for now. ${USAGE}`)
  if (workspaceId === undefined)
    return usageError(io, `--workspace=<id|segment> is required. ${USAGE}`)
  if (user === undefined) return usageError(io, `--user=<id|name> is required. ${USAGE}`)

  const dir = resolve(dataDir ?? resolveDefaultDataDir(env))
  await prepareDataDir(dir)
  const outcome = await grantMember(await getDb(dir), { workspaceId, user })
  io.stdout(`${JSON.stringify(outcome)}\n`)
  if (outcome.kind === 'ok') return 0
  io.stderr(`${REFUSAL[outcome.kind]}\n`)
  return 1
}

function usageError(io: Io, message: string): number {
  io.stderr(`${message}\n`)
  return 64
}
