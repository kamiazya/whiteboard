// Arg parser for `whiteboard server run --json [options]`.
//
// All value flags use inline form only (`--flag=<value>`). Space form
// (`--flag <value>`) is rejected to prevent silent token swallowing.
// Raw values are never echoed in error messages.
// --json is required. --dry-run and --trusted-proxy are boolean flags.

/**
 * Every value flag, and the field it lands in. ONE table, because the two
 * lists it replaced had to agree and nothing made them: a set of names that
 * must use the inline form, and eleven near-identical parse blocks. A flag
 * added to the blocks and not to the set would have accepted the SPACE form
 * and swallowed the next token — which is the exact failure the header above
 * says this parser exists to prevent.
 *
 * The result type derives from it too (`InlineValues`), so a flag cannot be
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

type InlineFlag = keyof typeof INLINE_VALUE_FLAGS

/**
 * Membership is asked of a Set, never with `in`: `in` walks the prototype
 * chain, so `'toString'` answers true for any object literal. That made
 * `whiteboard server run toString` report "toString requires the inline
 * form" — and echo the raw argument, which is the one thing the header above
 * says this parser never does. Found by differential-testing this rewrite
 * against the eleven blocks it replaced, not by reading it.
 */
const INLINE_FLAG_NAMES: ReadonlySet<string> = new Set(Object.keys(INLINE_VALUE_FLAGS))
type InlineValues = { [K in (typeof INLINE_VALUE_FLAGS)[InlineFlag]]: string | undefined }

/** The boolean flags, and how a repeat of one is detected. */
const BOOLEAN_FLAGS = ['--json', '--dry-run', '--trusted-proxy'] as const
type BooleanFlag = (typeof BOOLEAN_FLAGS)[number]

export type ServerRunArgs =
  | ({
      kind: 'ok'
      json: true
      dryRun: boolean
      trustedProxy: boolean | undefined
    } & InlineValues)
  | { kind: 'usage-error'; message: string }

function usageError(message: string): ServerRunArgs & { kind: 'usage-error' } {
  return { kind: 'usage-error', message }
}

function redactFlagValue(arg: string): string {
  if (!arg.startsWith('--')) return '[REDACTED_ARGUMENT]'
  const eq = arg.indexOf('=')
  if (eq === -1) return arg
  return `${arg.slice(0, eq)}=…`
}

/** The value flag this arg carries, or undefined when it carries none. */
function inlineFlagOf(arg: string): InlineFlag | undefined {
  return (Object.keys(INLINE_VALUE_FLAGS) as InlineFlag[]).find((flag) =>
    arg.startsWith(`${flag}=`),
  )
}

export function parseServerRunArgs(args: readonly string[]): ServerRunArgs {
  const seen = new Set<BooleanFlag>()
  const values: Partial<InlineValues> = {}

  for (const arg of args) {
    const booleanFlag = BOOLEAN_FLAGS.find((flag) => flag === arg)
    if (booleanFlag !== undefined) {
      if (seen.has(booleanFlag)) return usageError(`${booleanFlag} specified more than once`)
      seen.add(booleanFlag)
      continue
    }

    // A bare value flag: the space form would take the NEXT token as its
    // value, which is what the inline-only rule exists to refuse.
    if (INLINE_FLAG_NAMES.has(arg)) {
      return usageError(`${arg} requires the inline form: ${arg}=<value>`)
    }

    const flag = inlineFlagOf(arg)
    if (flag !== undefined) {
      const value = arg.slice(flag.length + 1)
      if (value.length === 0) return usageError(`${flag}=<value> requires a non-empty value`)
      const key = INLINE_VALUE_FLAGS[flag]
      if (values[key] !== undefined) return usageError(`${flag} specified more than once`)
      values[key] = value
      continue
    }

    return usageError(`Unknown argument: ${redactFlagValue(arg)}`)
  }

  if (!seen.has('--json')) {
    return usageError(
      'Only --json is supported for now. Re-run with: whiteboard server run --json [options]',
    )
  }

  return {
    kind: 'ok',
    json: true,
    dryRun: seen.has('--dry-run'),
    trustedProxy: seen.has('--trusted-proxy') ? true : undefined,
    externalUrl: values.externalUrl,
    allowedOrigins: values.allowedOrigins,
    authStrategy: values.authStrategy,
    jwtIssuer: values.jwtIssuer,
    jwtAudience: values.jwtAudience,
    jwksUri: values.jwksUri,
    jwtClockSkew: values.jwtClockSkew,
    jwtScopeClaim: values.jwtScopeClaim,
    host: values.host,
    port: values.port,
    dataDir: values.dataDir,
  }
}
