// Arg parser for `whiteboard server status --json` and
// `whiteboard server stop --json`. Both accept only --json and
// --data-dir=<path>; the inline-only rule is `scanFlags`'.

import { type FlagTable, scanFlags } from './flag-table.js'

export type ServerLifecycleArgs =
  | { kind: 'ok'; json: true; dataDir: string | undefined }
  | { kind: 'usage-error'; message: string }

const LIFECYCLE_FLAGS: FlagTable<'dataDir'> = {
  booleans: ['--json'],
  values: { '--data-dir': 'dataDir' },
}

export function parseServerLifecycleArgs(
  args: readonly string[],
  commandName: string,
): ServerLifecycleArgs {
  const scan = scanFlags(args, LIFECYCLE_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return {
      kind: 'usage-error',
      message: `Only --json is supported. Re-run with: whiteboard ${commandName} --json`,
    }
  }
  return { kind: 'ok', json: true, dataDir: scan.values.dataDir }
}
