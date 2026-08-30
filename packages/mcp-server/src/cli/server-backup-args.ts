// Arg parser for `whiteboard server backup --json --output-dir=<path>
// [--data-dir=<path>] [--mirror-dir=<path>]`.
//
// All value flags use inline form only (`--flag=<value>`). Space form is
// rejected to prevent silent token swallowing. Raw values are never echoed
// in error messages. --json is required.

import { isAbsolute } from 'node:path'
import { redactFlagValue, takeInlineValue } from './argv.js'

const SERVER_BACKUP_INLINE_FLAGS = new Set(['--output-dir', '--data-dir', '--mirror-dir'])

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

export function parseServerBackupArgs(args: readonly string[]): ServerBackupArgs {
  let json = false
  let outputDir: string | undefined
  let dataDir: string | undefined
  let mirrorDir: string | undefined

  for (const arg of args) {
    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }

    if (SERVER_BACKUP_INLINE_FLAGS.has(arg)) {
      return {
        kind: 'usage-error',
        message: `${arg} requires the inline form: ${arg}=<value>`,
      }
    }

    if (arg.startsWith('--output-dir=')) {
      const taken = takeInlineValue(arg, '--output-dir=')
      if ('kind' in taken) return taken
      if (outputDir !== undefined)
        return { kind: 'usage-error', message: '--output-dir specified more than once' }
      outputDir = taken.value
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

    if (arg.startsWith('--mirror-dir=')) {
      const taken = takeInlineValue(arg, '--mirror-dir=')
      if ('kind' in taken) return taken
      if (mirrorDir !== undefined)
        return { kind: 'usage-error', message: '--mirror-dir specified more than once' }
      if (!isAbsolute(taken.value)) {
        return {
          kind: 'usage-error',
          message:
            '--mirror-dir must be an absolute path; a relative one resolves against a working directory you did not choose',
        }
      }
      mirrorDir = taken.value
      continue
    }

    return { kind: 'usage-error', message: `Unknown argument: ${redactFlagValue(arg)}` }
  }

  if (!json) {
    return {
      kind: 'usage-error',
      message:
        'Only --json is supported for now. Re-run with: whiteboard server backup --json --output-dir=<path>',
    }
  }
  if (outputDir === undefined) {
    return {
      kind: 'usage-error',
      message:
        '--output-dir=<path> is required. Re-run with: whiteboard server backup --json --output-dir=<path>',
    }
  }

  return { kind: 'ok', json: true, outputDir, dataDir, mirrorDir }
}
