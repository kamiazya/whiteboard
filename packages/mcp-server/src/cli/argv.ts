// Arg parsers for daemon subcommands.
// Raw values are never echoed in error messages to prevent accidental
// token / path leaks in usage errors.

export function redactFlagValue(arg: string): string {
  if (!arg.startsWith('--')) return '[REDACTED_ARGUMENT]'
  const eq = arg.indexOf('=')
  if (eq === -1) return arg
  return `${arg.slice(0, eq)}=…`
}

type InlineValueResult =
  | { kind: 'usage-error'; message: string }
  | { value: string }

export function takeInlineValue(arg: string, prefix: string): InlineValueResult {
  const value = arg.slice(prefix.length)
  if (!value) {
    return {
      kind: 'usage-error',
      message: `${prefix.slice(0, -1)}=<value> requires a non-empty value`,
    }
  }
  return { value }
}

export type DaemonSubcommandArgs =
  | { kind: 'ok'; json: true; dataDir: string | undefined }
  | { kind: 'usage-error'; message: string }

export function parseDaemonSubcommandArgs(
  args: readonly string[],
  commandName: string,
): DaemonSubcommandArgs {
  let json = false
  let dataDir: string | undefined

  for (const arg of args) {
    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }
    if (arg === '--data-dir') {
      return {
        kind: 'usage-error',
        message: '--data-dir requires the inline form: --data-dir=<value>',
      }
    }
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length)
      if (!value)
        return { kind: 'usage-error', message: '--data-dir=<value> requires a non-empty value' }
      if (dataDir !== undefined)
        return { kind: 'usage-error', message: '--data-dir specified more than once' }
      dataDir = value
      continue
    }
    return { kind: 'usage-error', message: `Unknown argument: ${redactFlagValue(arg)}` }
  }

  if (!json) {
    return {
      kind: 'usage-error',
      message: `Only --json is supported. Re-run with: whiteboard daemon ${commandName} --json`,
    }
  }

  return { kind: 'ok', json: true, dataDir }
}

export type DaemonRunArgs =
  | {
      kind: 'ok'
      json: true
      host?: string
      port?: number
      dataDir?: string
      tokenStdin: boolean
      noOpen: boolean
    }
  | { kind: 'usage-error'; message: string }

export function parseDaemonRunArgs(args: readonly string[]): DaemonRunArgs {
  let json = false
  let host: string | undefined
  let port: number | undefined
  let dataDir: string | undefined
  let tokenStdin = false
  let noOpen = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }

    if (arg === '--token-stdin') {
      if (tokenStdin) return { kind: 'usage-error', message: '--token-stdin specified more than once' }
      tokenStdin = true
      continue
    }

    if (arg === '--no-open') {
      if (noOpen) return { kind: 'usage-error', message: '--no-open specified more than once' }
      noOpen = true
      continue
    }

    // Reject --token in both --token=<value> and --token <value> forms.
    // The value is intentionally NOT echoed to prevent token leaks.
    if (arg === '--token' || arg.startsWith('--token=')) {
      return {
        kind: 'usage-error',
        message: '--token is not accepted. Use --token-stdin or the WHITEBOARD_DAEMON_TOKEN env variable.',
      }
    }

    if (arg === '--host') {
      return {
        kind: 'usage-error',
        message: '--host requires the inline form: --host=<value>',
      }
    }
    if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length)
      if (!value) return { kind: 'usage-error', message: '--host=<value> requires a non-empty value' }
      if (host !== undefined) return { kind: 'usage-error', message: '--host specified more than once' }
      host = value
      continue
    }

    if (arg === '--port') {
      return {
        kind: 'usage-error',
        message: '--port requires the inline form: --port=<value>',
      }
    }
    if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length)
      const num = Number(value)
      if (!value || !Number.isInteger(num) || num <= 0 || num > 65535)
        return { kind: 'usage-error', message: '--port=<value> requires a valid port number (1–65535)' }
      if (port !== undefined) return { kind: 'usage-error', message: '--port specified more than once' }
      port = num
      continue
    }

    if (arg === '--data-dir') {
      return {
        kind: 'usage-error',
        message: '--data-dir requires the inline form: --data-dir=<value>',
      }
    }
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length)
      if (!value) return { kind: 'usage-error', message: '--data-dir=<value> requires a non-empty value' }
      if (dataDir !== undefined) return { kind: 'usage-error', message: '--data-dir specified more than once' }
      dataDir = value
      continue
    }

    return { kind: 'usage-error', message: `Unknown argument: ${redactFlagValue(arg)}` }
  }

  if (!json) {
    return {
      kind: 'usage-error',
      message: 'Only --json is supported. Re-run with: whiteboard daemon run --json',
    }
  }

  return { kind: 'ok', json: true, host, port, dataDir, tokenStdin, noOpen }
}

export type DaemonSupportBundleArgs =
  | { kind: 'ok'; json: true; outputDir: string; dataDir?: string }
  | { kind: 'usage-error'; message: string }

export function parseDaemonSupportBundleArgs(args: readonly string[]): DaemonSupportBundleArgs {
  let json = false
  let outputDir: string | undefined
  let dataDir: string | undefined

  for (const arg of args) {
    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }
    if (arg === '--output-dir') {
      return {
        kind: 'usage-error',
        message: '--output-dir requires the inline form: --output-dir=<value>',
      }
    }
    if (arg.startsWith('--output-dir=')) {
      const value = arg.slice('--output-dir='.length)
      if (!value)
        return { kind: 'usage-error', message: '--output-dir=<value> requires a non-empty value' }
      if (outputDir !== undefined)
        return { kind: 'usage-error', message: '--output-dir specified more than once' }
      outputDir = value
      continue
    }
    if (arg === '--data-dir') {
      return {
        kind: 'usage-error',
        message: '--data-dir requires the inline form: --data-dir=<value>',
      }
    }
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length)
      if (!value)
        return { kind: 'usage-error', message: '--data-dir=<value> requires a non-empty value' }
      if (dataDir !== undefined)
        return { kind: 'usage-error', message: '--data-dir specified more than once' }
      dataDir = value
      continue
    }
    return { kind: 'usage-error', message: `Unknown argument: ${redactFlagValue(arg)}` }
  }

  if (!json) {
    return {
      kind: 'usage-error',
      message: 'Only --json is supported. Re-run with: whiteboard daemon support-bundle --json --output-dir=<path>',
    }
  }

  if (!outputDir) {
    return {
      kind: 'usage-error',
      message: '--output-dir=<path> is required',
    }
  }

  return { kind: 'ok', json: true, outputDir, dataDir }
}
