// Arg parsers for daemon subcommands.
//
// Each one DECLARES its flags and lets `scanFlags` apply the inline-only
// rule; what stays here is the part that is this subcommand's own — which
// flags are required, and what the ok result is shaped like.

import { type FlagTable, redactFlagValue, scanFlags } from './flag-table.js'

export { redactFlagValue }

export type DaemonSubcommandArgs =
  | { kind: 'ok'; json: true; dataDir: string | undefined }
  | { kind: 'usage-error'; message: string }

const SUBCOMMAND_FLAGS: FlagTable<'dataDir'> = {
  booleans: ['--json'],
  values: { '--data-dir': 'dataDir' },
}

export function parseDaemonSubcommandArgs(
  args: readonly string[],
  commandName: string,
): DaemonSubcommandArgs {
  const scan = scanFlags(args, SUBCOMMAND_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return {
      kind: 'usage-error',
      message: `Only --json is supported. Re-run with: whiteboard ${commandName} --json`,
    }
  }
  return { kind: 'ok', json: true, dataDir: scan.values.dataDir }
}

export type DaemonRunArgs =
  | {
      kind: 'ok'
      json: true
      dataDir?: string
      tokenStdin: boolean
      noOpen: boolean
    }
  | { kind: 'usage-error'; message: string }

const RUN_FLAGS: FlagTable<'dataDir'> = {
  booleans: ['--json', '--token-stdin', '--no-open'],
  values: { '--data-dir': 'dataDir' },
  // The value must never reach an error message, so the flag is refused in
  // both forms rather than falling through to the redacting default.
  rejected: {
    '--token':
      '--token is not accepted. Use --token-stdin or the WHITEBOARD_DAEMON_TOKEN env variable.',
  },
}

export function parseDaemonRunArgs(args: readonly string[]): DaemonRunArgs {
  const scan = scanFlags(args, RUN_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return {
      kind: 'usage-error',
      message: 'Only --json is supported. Re-run with: whiteboard daemon run --json',
    }
  }
  return {
    kind: 'ok',
    json: true,
    dataDir: scan.values.dataDir,
    tokenStdin: scan.seen.has('--token-stdin'),
    noOpen: scan.seen.has('--no-open'),
  }
}

export type DaemonSupportBundleArgs =
  | { kind: 'ok'; json: true; outputDir: string; dataDir?: string }
  | { kind: 'usage-error'; message: string }

const SUPPORT_BUNDLE_FLAGS: FlagTable<'outputDir' | 'dataDir'> = {
  booleans: ['--json'],
  values: { '--output-dir': 'outputDir', '--data-dir': 'dataDir' },
}

export function parseDaemonSupportBundleArgs(args: readonly string[]): DaemonSupportBundleArgs {
  const scan = scanFlags(args, SUPPORT_BUNDLE_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return {
      kind: 'usage-error',
      message:
        'Only --json is supported. Re-run with: whiteboard daemon support-bundle --json --output-dir=<path>',
    }
  }
  if (scan.values.outputDir === undefined) {
    return { kind: 'usage-error', message: '--output-dir=<path> is required' }
  }
  return { kind: 'ok', json: true, outputDir: scan.values.outputDir, dataDir: scan.values.dataDir }
}
