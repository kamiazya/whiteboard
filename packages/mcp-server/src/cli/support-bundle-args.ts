// The flags of `whiteboard daemon support-bundle` and `whiteboard server
// support-bundle`: `--json --output-dir=<path> [--data-dir=<path>]`. One table
// and one parser, so a flag added to one command is on the other; each command
// supplies only the sentences that name itself.

import { type FlagTable, scanFlags } from './flag-table.js'

export type SupportBundleArgs =
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

/** What a command says when `--json` or `--output-dir` is absent. */
export interface SupportBundleWording {
  readonly jsonOnly: string
  readonly outputDirRequired: string
}

export function parseSupportBundleArgs(
  args: readonly string[],
  wording: SupportBundleWording,
): SupportBundleArgs {
  const scan = scanFlags(args, SUPPORT_BUNDLE_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) return { kind: 'usage-error', message: wording.jsonOnly }
  if (scan.values.outputDir === undefined) {
    return { kind: 'usage-error', message: wording.outputDirRequired }
  }
  return { kind: 'ok', json: true, outputDir: scan.values.outputDir, dataDir: scan.values.dataDir }
}

const SERVER_USAGE = 'Re-run with: whiteboard server support-bundle --json --output-dir=<path>'

export function parseServerSupportBundleArgs(args: readonly string[]): SupportBundleArgs {
  return parseSupportBundleArgs(args, {
    jsonOnly: `Only --json is supported for now. ${SERVER_USAGE}`,
    outputDirRequired: `--output-dir=<path> is required. ${SERVER_USAGE}`,
  })
}
