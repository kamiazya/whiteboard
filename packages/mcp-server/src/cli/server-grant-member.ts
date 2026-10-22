import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { createWorkspacePeopleAdministration } from '../server/security/people-administration.js'
import type { SignInProvider } from '../server/security/sign-in-config.js'
import { homeWithItsOwner } from '../server/security/workspace-namespace-home.js'
import { createWorkspaceRoles } from '../server/security/workspace-roles.js'
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
  type GrantMemberOutput,
  grantMemberOutputSchema,
  OPERATOR_JSON_SCHEMA_VERSION,
  operatorJsonLine,
  type WithoutSchemaVersion,
} from './operator-json.js'

export type GrantMemberOutcome = WithoutSchemaVersion<GrantMemberOutput>

/**
 * ADR-0046 decision 10: an operator grants a workspace's first member from
 * the machine that holds its data — the party ADR-0041 already trusts to
 * reopen one — so no web surface offers "adopt this workspace" to whoever is
 * signed in. The person must have signed in once, which is what makes them a
 * user here; they are named by user id or by provider and subject, and a
 * reference that reaches nobody is answered with the candidates.
 */
export async function grantMember(
  db: TenantDatabase,
  {
    workspaceId: workspaceHandle,
    user,
    providers = [],
  }: { workspaceId: string; user: UserReference; providers?: readonly SignInProvider[] },
): Promise<GrantMemberOutcome> {
  // A handle, as every other surface reads one (ADR-0019): the canonical id,
  // or a segment qualified by the namespace holding it (ADR-0053). The
  // operator has no namespace of their own, so a bare segment reaches only
  // the holder-less `me` one — never whichever of several namespaces holds it.
  const rows = await db.selectFrom('workspaces').select(['id', 'namespace', 'segment']).execute()
  const workspace = resolveWorkspaceHandle(
    rows.map((row) => ({
      workspaceId: row.id,
      namespace: row.namespace,
      ...(row.segment === null ? {} : { segment: row.segment }),
    })),
    workspaceHandle,
  )
  if (workspace === null) return { kind: 'unknown-workspace', workspaceId: workspaceHandle }
  const { workspaceId } = workspace

  const members = createMemberProfileStore(db)
  const found = await findNamedUser(db, user, providers)
  if (found.kind !== 'found') return found

  const granted = await createWorkspacePeopleAdministration({
    members,
    roles: createWorkspaceRoles(db),
  }).grant(workspaceId, found.user.id)
  if (granted.kind === 'refused') return operatorRefusal(granted)
  await homeWithItsOwner(db, workspaceId)
  return { kind: 'ok', workspaceId, user: found.user }
}

const USAGE = `Re-run with: whiteboard server grant-member --json --workspace=<id|handle/segment|segment> ${USER_REFERENCE_USAGE} [--data-dir=<path>]`

const REFUSAL: Record<Exclude<GrantMemberOutcome['kind'], 'ok'>, string> = {
  'unknown-workspace': 'grant refused: this data directory holds no workspace with that id.',
  'unknown-user': `grant refused: ${UNKNOWN_USER_GUIDANCE}`,
  'unknown-provider': `grant refused: ${UNKNOWN_PROVIDER_GUIDANCE}`,
}

/** `whiteboard server grant-member`: stdout is the outcome as one JSON line. */
export async function runServerGrantMember(
  args: readonly string[],
  io: Io = processIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scan = scanFlags(args, {
    booleans: ['--json'],
    values: { '--workspace': 'workspaceId', ...USER_REFERENCE_FLAGS, '--data-dir': 'dataDir' },
  })
  if (scan.kind === 'usage-error') return usageError(io, scan.message)
  const { workspaceId, dataDir } = scan.values
  if (!scan.seen.has('--json')) return usageError(io, `Only --json is supported for now. ${USAGE}`)
  if (workspaceId === undefined)
    return usageError(io, `--workspace=<id|handle/segment|segment> is required. ${USAGE}`)
  const reference = readUserReference(scan.values)
  if (reference.kind === 'usage-error') return usageError(io, `${reference.message} ${USAGE}`)

  const outcome = await grantMember(await openKeeperDb(dataDir, env), {
    workspaceId,
    user: reference.reference,
    providers: configuredProviders(env),
  })
  io.stdout(
    operatorJsonLine(grantMemberOutputSchema, {
      schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
      ...outcome,
    }),
  )
  if (outcome.kind === 'ok') return 0
  io.stderr(`${REFUSAL[outcome.kind]}\n`)
  return 1
}
