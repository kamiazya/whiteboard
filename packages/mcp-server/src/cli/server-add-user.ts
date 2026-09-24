import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { providerAuthenticator } from '../server/security/sign-in-config.js'
import { readSignInProviders, SIGN_IN_CONFIG_ENV } from '../server/security/sign-in-config-file.js'
import { scanFlags } from './flag-table.js'
import { type Io, openKeeperDb, processIo, usageError } from './operator-command.js'

const USAGE =
  'Re-run with: whiteboard server add-user --json --provider=<id> --subject=<sub> [--name=<display name>] [--data-dir=<path>]'

/**
 * `whiteboard server add-user`: the operator makes a person a user of this
 * keeper before their first sign-in, by the provider and the subject that
 * provider knows them by. What a sign-in or a bearer from that subject then
 * resolves to is this user.
 *
 * The operator's command, so it is not `admit()`'s to judge — the same party
 * ADR-0041 trusts to reopen a workspace. It is what keeps a provider with no
 * browser client invitation-only (ADR-0046 decision 4): a bearer cannot carry
 * an invitation, so without it the only way in is `createAccounts: true`.
 * It grants no workspace; `grant-member` does that.
 */
export async function runServerAddUser(
  args: readonly string[],
  io: Io = processIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scan = scanFlags(args, {
    booleans: ['--json'],
    values: {
      '--provider': 'provider',
      '--subject': 'subject',
      '--name': 'name',
      '--data-dir': 'dataDir',
    },
  })
  if (scan.kind === 'usage-error') return usageError(io, scan.message)
  const { provider: providerId, subject, name, dataDir } = scan.values
  if (!scan.seen.has('--json')) return usageError(io, `Only --json is supported for now. ${USAGE}`)
  if (providerId === undefined) return usageError(io, `--provider=<id> is required. ${USAGE}`)
  if (subject === undefined) return usageError(io, `--subject=<sub> is required. ${USAGE}`)

  const configPath = env[SIGN_IN_CONFIG_ENV]
  if (configPath === undefined || configPath === '') {
    io.stderr(`add-user refused: ${SIGN_IN_CONFIG_ENV} is not set, so no provider is declared.\n`)
    return 1
  }
  const providers = readSignInProviders(configPath)
  const provider = providers.find((p) => p.id === providerId)
  if (provider === undefined) {
    io.stdout(
      `${JSON.stringify({ kind: 'unknown-provider', providers: providers.map((p) => p.id) })}\n`,
    )
    io.stderr('add-user refused: no provider by that id; those declared are listed on stdout.\n')
    return 1
  }

  const members = createMemberProfileStore(await openKeeperDb(dataDir, env))
  const binding = { authenticator: providerAuthenticator(provider), subject }
  const existing = await members.profileForBinding(binding)
  const user = existing ?? (await members.ensureProfile({ binding, displayName: name ?? subject }))
  const outcome = {
    kind: 'ok',
    created: existing === null,
    user: { id: user.id, displayName: user.displayName },
  }
  io.stdout(`${JSON.stringify(outcome)}\n`)
  return 0
}
