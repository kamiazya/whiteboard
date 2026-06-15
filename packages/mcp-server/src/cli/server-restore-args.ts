// Arg parser for `whiteboard server restore --json --backup-dir=<path> --target-dir=<path>`.
//
// All value flags use inline form only (`--flag=<value>`). Space form is
// rejected to prevent silent token swallowing. Raw values are never echoed
// in error messages. --json is required. --backup-dir and --target-dir are
// both required.

import { redactFlagValue, takeInlineValue } from './argv.js'

const SERVER_RESTORE_INLINE_FLAGS = new Set(['--backup-dir', '--target-dir'])

export type ServerRestoreArgs =
  | {
      kind: 'ok'
      json: true
      backupDir: string
      targetDir: string
    }
  | { kind: 'usage-error'; message: string }

export function parseServerRestoreArgs(args: readonly string[]): ServerRestoreArgs {
  let json = false
  let backupDir: string | undefined
  let targetDir: string | undefined

  for (const arg of args) {
    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }

    if (SERVER_RESTORE_INLINE_FLAGS.has(arg)) {
      return {
        kind: 'usage-error',
        message: `${arg} requires the inline form: ${arg}=<value>`,
      }
    }

    if (arg.startsWith('--backup-dir=')) {
      const taken = takeInlineValue(arg, '--backup-dir=')
      if ('kind' in taken) return taken
      if (backupDir !== undefined)
        return { kind: 'usage-error', message: '--backup-dir specified more than once' }
      backupDir = taken.value
      continue
    }
    if (arg.startsWith('--target-dir=')) {
      const taken = takeInlineValue(arg, '--target-dir=')
      if ('kind' in taken) return taken
      if (targetDir !== undefined)
        return { kind: 'usage-error', message: '--target-dir specified more than once' }
      targetDir = taken.value
      continue
    }

    return { kind: 'usage-error', message: `Unknown argument: ${redactFlagValue(arg)}` }
  }

  if (!json) {
    return {
      kind: 'usage-error',
      message:
        'Only --json is supported for now. Re-run with: whiteboard server restore --json --backup-dir=<path> --target-dir=<path>',
    }
  }
  if (backupDir === undefined) {
    return {
      kind: 'usage-error',
      message:
        '--backup-dir=<path> is required. Re-run with: whiteboard server restore --json --backup-dir=<path> --target-dir=<path>',
    }
  }
  if (targetDir === undefined) {
    return {
      kind: 'usage-error',
      message:
        '--target-dir=<path> is required. Re-run with: whiteboard server restore --json --backup-dir=<path> --target-dir=<path>',
    }
  }

  return { kind: 'ok', json: true, backupDir, targetDir }
}
