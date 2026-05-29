// Arg parser for `whiteboard server status --json` and
// `whiteboard server stop --json`.
//
// Both commands accept only --json and --data-dir=<path>.
// Raw values are never echoed in error messages.

function redactFlagValue(arg: string): string {
  if (!arg.startsWith('--')) return '[REDACTED_ARGUMENT]'
  const eq = arg.indexOf('=')
  if (eq === -1) return arg
  return `${arg.slice(0, eq)}=…`
}

export type ServerLifecycleArgs =
  | { kind: 'ok'; json: true; dataDir: string | undefined }
  | { kind: 'usage-error'; message: string }

export function parseServerLifecycleArgs(
  args: readonly string[],
  commandName: string,
): ServerLifecycleArgs {
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
      message: `Only --json is supported. Re-run with: whiteboard ${commandName} --json`,
    }
  }

  return { kind: 'ok', json: true, dataDir }
}
