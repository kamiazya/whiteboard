// Arg parser for `whiteboard server run --json [options]`.
//
// The inline-only rule and the redaction are `scanFlags`'; what is here is
// this subcommand's own flag list and the shape of its ok result.

import { ENV_KEYS } from '../server/security/server-mode-env-config.js'
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

/**
 * The flags laid over a base env, as `server run` builds the configuration
 * it starts with. `server doctor` diagnoses the same configuration through
 * this same function — it carried a copy for a while, so a flag added to
 * one left the doctor checking a server that would never run.
 */
export function mergeCliFlagsIntoEnv(
  base: NodeJS.ProcessEnv,
  flags: ServerRunArgs & { kind: 'ok' },
): NodeJS.ProcessEnv {
  const env = { ...base }
  if (flags.externalUrl !== undefined) env[ENV_KEYS.EXTERNAL_URL] = flags.externalUrl
  if (flags.allowedOrigins !== undefined) env[ENV_KEYS.ALLOWED_ORIGINS] = flags.allowedOrigins
  if (flags.authStrategy !== undefined) env[ENV_KEYS.AUTH_STRATEGY] = flags.authStrategy
  if (flags.jwtIssuer !== undefined) env[ENV_KEYS.JWT_ISSUER] = flags.jwtIssuer
  if (flags.jwtAudience !== undefined) env[ENV_KEYS.JWT_AUDIENCE] = flags.jwtAudience
  if (flags.jwksUri !== undefined) env[ENV_KEYS.JWKS_URI] = flags.jwksUri
  if (flags.jwtClockSkew !== undefined) env[ENV_KEYS.JWT_CLOCK_SKEW_SECONDS] = flags.jwtClockSkew
  if (flags.jwtScopeClaim !== undefined) env[ENV_KEYS.JWT_SCOPE_CLAIM] = flags.jwtScopeClaim
  if (flags.host !== undefined) env[ENV_KEYS.HOST] = flags.host
  if (flags.port !== undefined) env[ENV_KEYS.PORT] = flags.port
  if (flags.dataDir !== undefined) env[ENV_KEYS.DATA_DIR] = flags.dataDir
  if (flags.trustedProxy === true) env[ENV_KEYS.TRUSTED_PROXY] = 'true'
  if (flags.trustedProxy === false) env[ENV_KEYS.TRUSTED_PROXY] = 'false'
  return env
}
