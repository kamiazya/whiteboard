// Arg parser for `whiteboard server run --json [options]`.
//
// The inline-only rule and the redaction are `scanFlags`'; what is here is
// this subcommand's own flag list and the shape of its ok result.

import { type FlagTable, scanFlags } from './flag-table.js'

/**
 * Every value flag, and the field it lands in. ONE table, because the two
 * lists it replaced had to agree and nothing made them: a set of names that
 * must use the inline form, and eleven near-identical parse blocks. A flag
 * added to the blocks and not to the set would have accepted the SPACE form
 * and swallowed the next token.
 *
 * The result type derives from it (`InlineValues`), so a flag cannot be
 * added without a field, or a field kept after its flag goes.
 */
const INLINE_VALUE_FLAGS = {
  '--external-url': 'externalUrl',
  '--allowed-origins': 'allowedOrigins',
  '--auth-strategy': 'authStrategy',
  '--jwt-issuer': 'jwtIssuer',
  '--jwt-audience': 'jwtAudience',
  '--jwks-uri': 'jwksUri',
  '--jwt-clock-skew': 'jwtClockSkew',
  '--jwt-scope-claim': 'jwtScopeClaim',
  '--host': 'host',
  '--port': 'port',
  '--data-dir': 'dataDir',
} as const

type InlineField = (typeof INLINE_VALUE_FLAGS)[keyof typeof INLINE_VALUE_FLAGS]
type InlineValues = { [K in InlineField]: string | undefined }

const RUN_FLAGS: FlagTable<InlineField> = {
  booleans: ['--json', '--dry-run', '--trusted-proxy'],
  values: INLINE_VALUE_FLAGS,
}

export type ServerRunArgs =
  | ({
      kind: 'ok'
      json: true
      dryRun: boolean
      trustedProxy: boolean | undefined
    } & InlineValues)
  | { kind: 'usage-error'; message: string }

export function parseServerRunArgs(args: readonly string[]): ServerRunArgs {
  const scan = scanFlags(args, RUN_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return {
      kind: 'usage-error',
      message:
        'Only --json is supported for now. Re-run with: whiteboard server run --json [options]',
    }
  }
  return {
    kind: 'ok',
    json: true,
    dryRun: scan.seen.has('--dry-run'),
    trustedProxy: scan.seen.has('--trusted-proxy') ? true : undefined,
    externalUrl: scan.values.externalUrl,
    allowedOrigins: scan.values.allowedOrigins,
    authStrategy: scan.values.authStrategy,
    jwtIssuer: scan.values.jwtIssuer,
    jwtAudience: scan.values.jwtAudience,
    jwksUri: scan.values.jwksUri,
    jwtClockSkew: scan.values.jwtClockSkew,
    jwtScopeClaim: scan.values.jwtScopeClaim,
    host: scan.values.host,
    port: scan.values.port,
    dataDir: scan.values.dataDir,
  }
}
