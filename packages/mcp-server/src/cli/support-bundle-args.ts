// Arg parser for `whiteboard server support-bundle --json --output-dir=<path> [--data-dir=<path>]`.

import { type FlagTable, scanFlags } from './flag-table.js'

export type ServerSupportBundleArgs =
  | {
      kind: 'ok'
      json: true
      outputDir: string
      dataDir: string | undefined
    }
  | { kind: 'usage-error'; message: string }

const SUPPORT_BUNDLE_FLAGS: FlagTable<'outputDir' | 'dataDir'> = {
  booleans: ['--json'],
  values: { '--output-dir': 'outputDir', '--data-dir': 'dataDir' },
}

const USAGE = 'Re-run with: whiteboard server support-bundle --json --output-dir=<path>'

export function parseServerSupportBundleArgs(args: readonly string[]): ServerSupportBundleArgs {
  const scan = scanFlags(args, SUPPORT_BUNDLE_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return { kind: 'usage-error', message: `Only --json is supported for now. ${USAGE}` }
  }
  if (scan.values.outputDir === undefined) {
    return { kind: 'usage-error', message: `--output-dir=<path> is required. ${USAGE}` }
  }
  return { kind: 'ok', json: true, outputDir: scan.values.outputDir, dataDir: scan.values.dataDir }
}
