/**
 * The four `server *-args` parsers, rewritten onto `scanFlags`, judged
 * against the hand-written loops they replaced. Same arrangement and the
 * same reasoning as argv.differential.test.ts: the oracle is the OLD code,
 * frozen, and it must not be re-synced.
 *
 * ONE case is excluded because the answer deliberately changed, and it is
 * spelled out rather than filtered silently. `--mirror-dir` was the only
 * flag in the family whose own check ran AFTER its duplicate check, so
 * `--mirror-dir=/a --mirror-dir=rel` used to report "specified more than
 * once" and now reports the absolute-path requirement. Every other flag,
 * including `--port`, already checked its value first. Both answers are
 * true and both are usage errors; what matters for an inline-only parser is
 * that nothing becomes ACCEPTED that was rejected, and no exclusion here
 * touches that.
 */
import { isAbsolute } from 'node:path'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../shared/test-utils/fast-check.js'
import { parseServerBackupArgs } from './server-backup-args.js'
import { parseServerLifecycleArgs } from './server-lifecycle-args.js'
import { parseServerRestoreArgs } from './server-restore-args.js'
import { parseServerSupportBundleArgs } from './server-support-bundle-args.js'

type Result = { kind: 'usage-error'; message: string } | Record<string, unknown>

function oldRedact(arg: string): string {
  if (!arg.startsWith('--')) return '[REDACTED_ARGUMENT]'
  const eq = arg.indexOf('=')
  if (eq === -1) return arg
  return `${arg.slice(0, eq)}=…`
}

function oldTake(
  arg: string,
  prefix: string,
): { kind: 'usage-error'; message: string } | { value: string } {
  const value = arg.slice(prefix.length)
  if (!value) {
    return {
      kind: 'usage-error',
      message: `${prefix.slice(0, -1)}=<value> requires a non-empty value`,
    }
  }
  return { value }
}

function oldLifecycle(args: readonly string[], commandName: string): Result {
  let json = false
  let dataDir: string | undefined
  for (const arg of args) {
    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }
    if (arg === '--data-dir') {
      return {
        kind: 'usage-error',
        message: '--data-dir requires the inline form: --data-dir=<value>',
      }
    }
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length)
      if (!value)
        return { kind: 'usage-error', message: '--data-dir=<value> requires a non-empty value' }
      if (dataDir !== undefined)
        return { kind: 'usage-error', message: '--data-dir specified more than once' }
      dataDir = value
      continue
    }
    return { kind: 'usage-error', message: `Unknown argument: ${oldRedact(arg)}` }
  }
  if (!json) {
    return {
      kind: 'usage-error',
      message: `Only --json is supported. Re-run with: whiteboard ${commandName} --json`,
    }
  }
  return { kind: 'ok', json: true, dataDir }
}

function oldSupportBundle(args: readonly string[]): Result {
  const inline = new Set(['--output-dir', '--data-dir'])
  let json = false
  let outputDir: string | undefined
  let dataDir: string | undefined
  for (const arg of args) {
    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }
    if (inline.has(arg)) {
      return { kind: 'usage-error', message: `${arg} requires the inline form: ${arg}=<value>` }
    }
    if (arg.startsWith('--output-dir=')) {
      const taken = oldTake(arg, '--output-dir=')
      if ('kind' in taken) return taken
      if (outputDir !== undefined)
        return { kind: 'usage-error', message: '--output-dir specified more than once' }
      outputDir = taken.value
      continue
    }
    if (arg.startsWith('--data-dir=')) {
      const taken = oldTake(arg, '--data-dir=')
      if ('kind' in taken) return taken
      if (dataDir !== undefined)
        return { kind: 'usage-error', message: '--data-dir specified more than once' }
      dataDir = taken.value
      continue
    }
    return { kind: 'usage-error', message: `Unknown argument: ${oldRedact(arg)}` }
  }
  if (!json) {
    return {
      kind: 'usage-error',
      message:
        'Only --json is supported for now. Re-run with: whiteboard server support-bundle --json --output-dir=<path>',
    }
  }
  if (outputDir === undefined) {
    return {
      kind: 'usage-error',
      message:
        '--output-dir=<path> is required. Re-run with: whiteboard server support-bundle --json --output-dir=<path>',
    }
  }
  return { kind: 'ok', json: true, outputDir, dataDir }
}

function oldRestore(args: readonly string[]): Result {
  const inline = new Set(['--backup-dir', '--target-dir'])
  let json = false
  let backupDir: string | undefined
  let targetDir: string | undefined
  for (const arg of args) {
    if (arg === '--json') {
      if (json) return { kind: 'usage-error', message: '--json specified more than once' }
      json = true
      continue
    }
    if (inline.has(arg)) {
      return { kind: 'usage-error', message: `${arg} requires the inline form: ${arg}=<value>` }
    }
    if (arg.startsWith('--backup-dir=')) {
      const taken = oldTake(arg, '--backup-dir=')
      if ('kind' in taken) return taken
      if (backupDir !== undefined)
        return { kind: 'usage-error', message: '--backup-dir specified more than once' }
      backupDir = taken.value
      continue
    }
    if (arg.startsWith('--target-dir=')) {
      const taken = oldTake(arg, '--target-dir=')
      if ('kind' in taken) return taken
      if (targetDir !== undefined)
        return { kind: 'usage-error', message: '--target-dir specified more than once' }
      targetDir = taken.value
      continue
    }
    return { kind: 'usage-error', message: `Unknown argument: ${oldRedact(arg)}` }
  }
  const usage =
    'Re-run with: whiteboard server restore --json --backup-dir=<path> --target-dir=<path>'
  if (!json) {
    return { kind: 'usage-error', message: `Only --json is supported for now. ${usage}` }
  }
  if (backupDir === undefined) {
    return { kind: 'usage-error', message: `--backup-dir=<path> is required. ${usage}` }
  }
  if (targetDir === undefined) {
    return { kind: 'usage-error', message: `--target-dir=<path> is required. ${usage}` }
  }
  return { kind: 'ok', json: true, backupDir, targetDir }
}

function oldBackup(args: readonly string[]): Result {
  const inline = new Set(['--output-dir', '--data-dir', '--mirror-dir'])
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
    if (inline.has(arg)) {
      return { kind: 'usage-error', message: `${arg} requires the inline form: ${arg}=<value>` }
    }
    if (arg.startsWith('--output-dir=')) {
      const taken = oldTake(arg, '--output-dir=')
      if ('kind' in taken) return taken
      if (outputDir !== undefined)
        return { kind: 'usage-error', message: '--output-dir specified more than once' }
      outputDir = taken.value
      continue
    }
    if (arg.startsWith('--data-dir=')) {
      const taken = oldTake(arg, '--data-dir=')
      if ('kind' in taken) return taken
      if (dataDir !== undefined)
        return { kind: 'usage-error', message: '--data-dir specified more than once' }
      dataDir = taken.value
      continue
    }
    if (arg.startsWith('--mirror-dir=')) {
      const taken = oldTake(arg, '--mirror-dir=')
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
    return { kind: 'usage-error', message: `Unknown argument: ${oldRedact(arg)}` }
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

const FLAGS = [
  '--json',
  '--output-dir',
  '--output-dir=',
  '--output-dir=/tmp/out',
  '--data-dir',
  '--data-dir=',
  '--data-dir=/tmp/data',
  '--mirror-dir',
  '--mirror-dir=',
  '--mirror-dir=/tmp/mirror',
  '--mirror-dir=relative/path',
  '--backup-dir',
  '--backup-dir=',
  '--backup-dir=/tmp/backup',
  '--target-dir',
  '--target-dir=',
  '--target-dir=/tmp/target',
  '--unknown',
  '--unknown=value',
  'toString',
  'constructor',
  '--toString',
  'bare-word',
  '',
]

const argLists = fc.array(fc.constantFrom(...FLAGS), { minLength: 0, maxLength: 5 })

/**
 * The one deliberate divergence, described in this file's header: a REPEAT
 * of `--mirror-dir` whose later value is relative. Excluded by the shape
 * that produces it, not by its message, so a rewrite that started reporting
 * the wrong thing for a SINGLE relative `--mirror-dir` is still caught.
 */
function isReorderedMirrorCase(args: readonly string[]): boolean {
  const mirrors = args.filter((arg) => arg.startsWith('--mirror-dir='))
  return mirrors.length > 1 && mirrors.some((arg) => !isAbsolute(arg.slice('--mirror-dir='.length)))
}

describe('the server arg parsers answer exactly what the loops they replaced answered', () => {
  fcTest.prop([argLists, fc.constantFrom('server status', 'server stop')], withDefaults())(
    'server status and stop',
    (args, commandName) => {
      expect(parseServerLifecycleArgs(args, commandName)).toEqual(oldLifecycle(args, commandName))
    },
  )

  fcTest.prop([argLists], withDefaults())('server support-bundle', (args) => {
    expect(parseServerSupportBundleArgs(args)).toEqual(oldSupportBundle(args))
  })

  fcTest.prop([argLists], withDefaults())('server restore', (args) => {
    expect(parseServerRestoreArgs(args)).toEqual(oldRestore(args))
  })

  fcTest.prop([argLists], withDefaults())('server backup', (args) => {
    fc.pre(!isReorderedMirrorCase(args))
    expect(parseServerBackupArgs(args)).toEqual(oldBackup(args))
  })
})
