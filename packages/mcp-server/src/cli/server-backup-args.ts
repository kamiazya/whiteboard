// Arg parser for `whiteboard server backup --json --output-dir=<path> [--data-dir=<path>]`.
//
// All value flags use inline form only (`--flag=<value>`). Space form is
// rejected to prevent silent token swallowing. Raw values are never echoed
// in error messages. --json is required.

import { redactFlagValue, takeInlineValue } from './argv.js'

const SERVER_BACKUP_INLINE_FLAGS = new Set(['--output-dir', '--data-dir'])

export type ServerBackupArgs =
  | {
      kind: 'ok'
      json: true
      outputDir: string
      dataDir: string | undefined
    }
  | { kind: 'usage-error'; message: string }

export function parseServerBackupArgs(args: readonly string[]): ServerBackupArgs {
  let json = false
  let outputDir: string | undefined
  let dataDir: string | undefined

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

  return { kind: 'ok', json: true, outputDir, dataDir }
}
