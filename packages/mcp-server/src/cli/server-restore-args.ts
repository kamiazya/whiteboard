// Arg parser for `whiteboard server restore --json --backup-dir=<path> --target-dir=<path>`.

import { type FlagTable, scanFlags } from './flag-table.js'

export type ServerRestoreArgs =
  | {
      kind: 'ok'
      json: true
      backupDir: string
      targetDir: string
    }
  | { kind: 'usage-error'; message: string }

const RESTORE_FLAGS: FlagTable<'backupDir' | 'targetDir'> = {
  booleans: ['--json'],
  values: { '--backup-dir': 'backupDir', '--target-dir': 'targetDir' },
}

const USAGE =
  'Re-run with: whiteboard server restore --json --backup-dir=<path> --target-dir=<path>'

export function parseServerRestoreArgs(args: readonly string[]): ServerRestoreArgs {
  const scan = scanFlags(args, RESTORE_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return { kind: 'usage-error', message: `Only --json is supported for now. ${USAGE}` }
  }
  if (scan.values.backupDir === undefined) {
    return { kind: 'usage-error', message: `--backup-dir=<path> is required. ${USAGE}` }
  }
  if (scan.values.targetDir === undefined) {
    return { kind: 'usage-error', message: `--target-dir=<path> is required. ${USAGE}` }
  }
  return {
    kind: 'ok',
    json: true,
    backupDir: scan.values.backupDir,
    targetDir: scan.values.targetDir,
  }
}
