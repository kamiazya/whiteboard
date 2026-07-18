// `whiteboard trust list|revoke <origin>|revoke --all` — the one operator-
// facing revocation mechanism for the silent-reconnect trust store (see
// server/security/web-origin-trust-store.ts). Routed from dispatcher.ts's
// `trust` command; the dispatcher owns stdout/stderr placement and the
// --data-dir flag, this module owns the subcommand behavior.

import type { WebOriginTrustStore } from '../server/security/web-origin-trust-store.js'

export interface TrustCommandResult {
  exitCode: 0 | 1
  output: string
}

function formatList(records: readonly { origin: string; lastUsedAt: string }[]): string {
  if (records.length === 0) return 'no trusted origins'
  return records.map((r) => `${r.origin}\tlast used ${r.lastUsedAt}`).join('\n')
}

export async function runTrustCommand(
  args: readonly string[],
  trustStore: WebOriginTrustStore,
): Promise<TrustCommandResult> {
  const [subcommand, ...rest] = args

  if (subcommand === 'list') {
    const records = await trustStore.list()
    return { exitCode: 0, output: formatList(records) }
  }

  if (subcommand === 'revoke') {
    if (rest[0] === '--all') {
      await trustStore.revokeAll()
      return { exitCode: 0, output: 'revoked all trusted origins' }
    }
    const origin = rest[0]
    if (!origin) {
      return { exitCode: 1, output: 'usage: whiteboard trust revoke <origin> | --all' }
    }
    const before = await trustStore.list()
    if (!before.some((r) => r.origin === origin)) {
      return { exitCode: 1, output: `unknown origin: ${origin}` }
    }
    await trustStore.revoke(origin)
    return { exitCode: 0, output: `revoked ${origin}` }
  }

  return { exitCode: 1, output: 'usage: whiteboard trust list | revoke <origin> | revoke --all' }
}
