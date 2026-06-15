// Arg parser for `whiteboard server run --json [options]`.
//
// All value flags use inline form only (`--flag=<value>`). Space form
// (`--flag <value>`) is rejected to prevent silent token swallowing.
// Raw values are never echoed in error messages.
// --json is required. --dry-run and --trusted-proxy are boolean flags.

const SERVER_RUN_INLINE_FLAGS = new Set([
  '--external-url',
  '--allowed-origins',
  '--auth-strategy',
  '--jwt-issuer',
  '--jwt-audience',
  '--jwks-uri',
  '--jwt-clock-skew',
  '--jwt-scope-claim',
  '--host',
  '--port',
  '--data-dir',
])

export type ServerRunArgs =
  | {
      kind: 'ok'
      json: true
      dryRun: boolean
      trustedProxy: boolean | undefined
      externalUrl: string | undefined
      allowedOrigins: string | undefined
      authStrategy: string | undefined
      jwtIssuer: string | undefined
      jwtAudience: string | undefined
      jwksUri: string | undefined
      jwtClockSkew: string | undefined
      jwtScopeClaim: string | undefined
      host: string | undefined
      port: string | undefined
      dataDir: string | undefined
    }
  | { kind: 'usage-error'; message: string }

function redactFlagValue(arg: string): string {
  if (!arg.startsWith('--')) return '[REDACTED_ARGUMENT]'
  const eq = arg.indexOf('=')
  if (eq === -1) return arg
  return `${arg.slice(0, eq)}=…`
}

function takeInlineValue(
  arg: string,
  prefix: string,
): { value: string } | { kind: 'usage-error'; message: string } {
  const value = arg.slice(prefix.length)
  if (value.length === 0) {
    return { kind: 'usage-error', message: `${prefix}<value> requires a non-empty value` }
  }
  return { value }
}

export function parseServerRunArgs(args: readonly string[]): ServerRunArgs {
  let json = false
  let dryRun = false
  let trustedProxy: boolean | undefined
  let externalUrl: string | undefined
  let allowedOrigins: string | undefined
  let authStrategy: string | undefined
  let jwtIssuer: string | undefined
  let jwtAudience: string | undefined
  let jwksUri: string | undefined
  let jwtClockSkew: string | undefined
  let jwtScopeClaim: string | undefined
  let host: string | undefined
  let port: string | undefined
  let dataDir: string | undefined

  for (const arg of args) {
    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }
    if (arg === '--dry-run') {
      if (dryRun) return { kind: 'usage-error', message: '--dry-run specified more than once' }
      dryRun = true
      continue
    }
    if (arg === '--trusted-proxy') {
      if (trustedProxy !== undefined)
        return { kind: 'usage-error', message: '--trusted-proxy specified more than once' }
      trustedProxy = true
      continue
    }

    if (SERVER_RUN_INLINE_FLAGS.has(arg)) {
      return {
        kind: 'usage-error',
        message: `${arg} requires the inline form: ${arg}=<value>`,
      }
    }

    if (arg.startsWith('--external-url=')) {
      const taken = takeInlineValue(arg, '--external-url=')
      if ('kind' in taken) return taken
      if (externalUrl !== undefined)
        return { kind: 'usage-error', message: '--external-url specified more than once' }
      externalUrl = taken.value
      continue
    }
    if (arg.startsWith('--allowed-origins=')) {
      const taken = takeInlineValue(arg, '--allowed-origins=')
      if ('kind' in taken) return taken
      if (allowedOrigins !== undefined)
        return { kind: 'usage-error', message: '--allowed-origins specified more than once' }
      allowedOrigins = taken.value
      continue
    }
    if (arg.startsWith('--auth-strategy=')) {
      const taken = takeInlineValue(arg, '--auth-strategy=')
      if ('kind' in taken) return taken
      if (authStrategy !== undefined)
        return { kind: 'usage-error', message: '--auth-strategy specified more than once' }
      authStrategy = taken.value
      continue
    }
    if (arg.startsWith('--jwt-issuer=')) {
      const taken = takeInlineValue(arg, '--jwt-issuer=')
      if ('kind' in taken) return taken
      if (jwtIssuer !== undefined)
        return { kind: 'usage-error', message: '--jwt-issuer specified more than once' }
      jwtIssuer = taken.value
      continue
    }
    if (arg.startsWith('--jwt-audience=')) {
      const taken = takeInlineValue(arg, '--jwt-audience=')
      if ('kind' in taken) return taken
      if (jwtAudience !== undefined)
        return { kind: 'usage-error', message: '--jwt-audience specified more than once' }
      jwtAudience = taken.value
      continue
    }
    if (arg.startsWith('--jwks-uri=')) {
      const taken = takeInlineValue(arg, '--jwks-uri=')
      if ('kind' in taken) return taken
      if (jwksUri !== undefined)
        return { kind: 'usage-error', message: '--jwks-uri specified more than once' }
      jwksUri = taken.value
      continue
    }
    if (arg.startsWith('--jwt-clock-skew=')) {
      const taken = takeInlineValue(arg, '--jwt-clock-skew=')
      if ('kind' in taken) return taken
      if (jwtClockSkew !== undefined)
        return { kind: 'usage-error', message: '--jwt-clock-skew specified more than once' }
      jwtClockSkew = taken.value
      continue
    }
    if (arg.startsWith('--jwt-scope-claim=')) {
      const taken = takeInlineValue(arg, '--jwt-scope-claim=')
      if ('kind' in taken) return taken
      if (jwtScopeClaim !== undefined)
        return { kind: 'usage-error', message: '--jwt-scope-claim specified more than once' }
      jwtScopeClaim = taken.value
      continue
    }
    if (arg.startsWith('--host=')) {
      const taken = takeInlineValue(arg, '--host=')
      if ('kind' in taken) return taken
      if (host !== undefined)
        return { kind: 'usage-error', message: '--host specified more than once' }
      host = taken.value
      continue
    }
    if (arg.startsWith('--port=')) {
      const taken = takeInlineValue(arg, '--port=')
      if ('kind' in taken) return taken
      if (port !== undefined)
        return { kind: 'usage-error', message: '--port specified more than once' }
      port = taken.value
      continue
    }
    if (arg.startsWith('--data-dir=')) {
      const taken = takeInlineValue(arg, '--data-dir=')
      if ('kind' in taken) return taken
      if (dataDir !== undefined)
        return { kind: 'usage-error', message: '--data-dir specified more than once' }
      dataDir = taken.value
      continue
    }

    return { kind: 'usage-error', message: `Unknown argument: ${redactFlagValue(arg)}` }
  }

  if (!json) {
    return {
      kind: 'usage-error',
      message:
        'Only --json is supported for now. Re-run with: whiteboard server run --json [options]',
    }
  }

  return {
    kind: 'ok',
    json: true,
    dryRun,
    trustedProxy,
    externalUrl,
    allowedOrigins,
    authStrategy,
    jwtIssuer,
    jwtAudience,
    jwksUri,
    jwtClockSkew,
    jwtScopeClaim,
    host,
    port,
    dataDir,
  }
}
