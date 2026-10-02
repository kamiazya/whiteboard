// Arg parsers for daemon subcommands.
//
// Each one DECLARES its flags and lets `scanFlags` apply the inline-only
// rule; what stays here is the part that is this subcommand's own — which
// flags are required, and what the ok result is shaped like.

import { type FlagTable, redactFlagValue, scanFlags } from './flag-table.js'
import { parseSupportBundleArgs, type SupportBundleArgs } from './support-bundle-args.js'

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
      /** The machine form: one JSON ready line. Absent, the ready line is prose for a person. */
      json: boolean
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
  return {
    kind: 'ok',
    json: scan.seen.has('--json'),
    dataDir: scan.values.dataDir,
    tokenStdin: scan.seen.has('--token-stdin'),
    noOpen: scan.seen.has('--no-open'),
  }
}

export type DaemonReplicaKeyArgs =
  | { kind: 'ok'; json: true; workspaceId: string; dataDir: string | undefined }
  | { kind: 'usage-error'; message: string }

const REPLICA_KEY_FLAGS: FlagTable<'workspaceId' | 'dataDir'> = {
  booleans: ['--json'],
  values: { '--workspace': 'workspaceId', '--data-dir': 'dataDir' },
}

export function parseDaemonReplicaKeyArgs(args: readonly string[]): DaemonReplicaKeyArgs {
  const scan = scanFlags(args, REPLICA_KEY_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return {
      kind: 'usage-error',
      message:
        'Only --json is supported. Re-run with: whiteboard daemon rotate-replica-key --json --workspace=<id|segment>',
    }
  }
  if (scan.values.workspaceId === undefined) {
    return { kind: 'usage-error', message: '--workspace=<id|segment> is required' }
  }
  return {
    kind: 'ok',
    json: true,
    workspaceId: scan.values.workspaceId,
    dataDir: scan.values.dataDir,
  }
}

const REPLICA_TIERS = ['no-offline', 'offline', 'bounded'] as const
type ReplicaTierFlag = (typeof REPLICA_TIERS)[number]

export type DaemonReplicaTierArgs =
  | {
      kind: 'ok'
      json: true
      workspaceId: string
      /** `null` is the explicit clear (`--tier=default`). */
      tier: ReplicaTierFlag | null
      dataDir: string | undefined
    }
  | { kind: 'usage-error'; message: string }

const REPLICA_TIER_FLAGS: FlagTable<'workspaceId' | 'tier' | 'dataDir'> = {
  booleans: ['--json'],
  values: { '--workspace': 'workspaceId', '--tier': 'tier', '--data-dir': 'dataDir' },
}

export function parseDaemonReplicaTierArgs(args: readonly string[]): DaemonReplicaTierArgs {
  const scan = scanFlags(args, REPLICA_TIER_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return {
      kind: 'usage-error',
      message:
        'Only --json is supported. Re-run with: whiteboard daemon set-replica-tier --json --workspace=<id|segment> --tier=<no-offline|offline|bounded|default>',
    }
  }
  if (scan.values.workspaceId === undefined) {
    return { kind: 'usage-error', message: '--workspace=<id|segment> is required' }
  }
  const tier = scan.values.tier
  if (tier === undefined) {
    return {
      kind: 'usage-error',
      message: '--tier=<no-offline|offline|bounded|default> is required',
    }
  }
  if (tier !== 'default' && !REPLICA_TIERS.includes(tier as ReplicaTierFlag)) {
    return {
      kind: 'usage-error',
      message: `--tier must be one of ${REPLICA_TIERS.join(', ')}, or default (clears the override)`,
    }
  }
  return {
    kind: 'ok',
    json: true,
    workspaceId: scan.values.workspaceId,
    tier: tier === 'default' ? null : (tier as ReplicaTierFlag),
    dataDir: scan.values.dataDir,
  }
}

export function parseDaemonSupportBundleArgs(args: readonly string[]): SupportBundleArgs {
  return parseSupportBundleArgs(args, {
    jsonOnly:
      'Only --json is supported. Re-run with: whiteboard daemon support-bundle --json --output-dir=<path>',
    outputDirRequired: '--output-dir=<path> is required',
  })
}
