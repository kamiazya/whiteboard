// Arg parser for `whiteboard server backup --json --output-dir=<path>
// [--data-dir=<path>] [--mirror-dir=<path>]`.

import { isAbsolute } from 'node:path'
import { type FlagTable, scanFlags } from './flag-table.js'

export type ServerBackupArgs =
  | {
      kind: 'ok'
      json: true
      outputDir: string
      dataDir: string | undefined
      /**
       * Where the blob mirror lives, when it is shared with other backups.
       * Absent means the backup keeps its own mirror inside `outputDir` and
       * stays carryable on its own; the scheduler passes the backup root so
       * its retained runs share one.
       */
      mirrorDir: string | undefined
    }
  | { kind: 'usage-error'; message: string }

/**
 * A relative mirror resolves against a working directory the person running
 * a scheduled backup did not choose, so it is refused rather than resolved.
 */
function checkMirrorDir(value: string): string | undefined {
  if (value.length === 0) return '--mirror-dir=<value> requires a non-empty value'
  if (!isAbsolute(value)) {
    return '--mirror-dir must be an absolute path; a relative one resolves against a working directory you did not choose'
  }
  return undefined
}

const BACKUP_FLAGS: FlagTable<'outputDir' | 'dataDir' | 'mirrorDir'> = {
  booleans: ['--json'],
  values: {
    '--output-dir': 'outputDir',
    '--data-dir': 'dataDir',
    '--mirror-dir': 'mirrorDir',
  },
  checks: { '--mirror-dir': checkMirrorDir },
}

const USAGE = 'Re-run with: whiteboard server backup --json --output-dir=<path>'

export function parseServerBackupArgs(args: readonly string[]): ServerBackupArgs {
  const scan = scanFlags(args, BACKUP_FLAGS)
  if (scan.kind === 'usage-error') return scan
  if (!scan.seen.has('--json')) {
    return { kind: 'usage-error', message: `Only --json is supported for now. ${USAGE}` }
  }
  if (scan.values.outputDir === undefined) {
    return { kind: 'usage-error', message: `--output-dir=<path> is required. ${USAGE}` }
  }
  return {
    kind: 'ok',
    json: true,
    outputDir: scan.values.outputDir,
    dataDir: scan.values.dataDir,
    mirrorDir: scan.values.mirrorDir,
  }
}
