// The scheduled backup, run as its own process.
//
// `VACUUM INTO` through `@libsql/client` blocks the Node event loop for its
// whole duration — measured with a 5ms sampler that fired ZERO times across a
// 4767ms snapshot of a 421MB database, and roughly linear below that (33ms
// empty, 314ms at 25MB, 1242ms at 103MB). Inside the daemon that is every
// HTTP request, WebSocket frame and MCP call stopped for seconds, nightly,
// and it grows with the data. The blob copy is well behaved by comparison
// (under 3.1ms of lag across a 200MB tree), but the pass moves whole: putting
// the two halves of one backup in two places would need them to agree about
// the marker, the lease and the output directory for no gain.
//
// The child is the CLI this package already ships and already smoke-tests, so
// the scheduled path and the manual one stay the same program rather than two
// implementations that happen to agree today. Everything the two processes
// must coordinate on was already designed to cross a process boundary: the
// in-progress marker is a file in the data directory, and the leader lease is
// a row in the shared database.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { WHITEBOARD_ROOT } from '../config.js'
import { getLogger } from '../log.js'
import type { ServerBackupOutcome } from './backup-pass.js'
import { serverBackupResultSchema } from './backup-pass.js'

const log = getLogger('backup-subprocess')

/** Enough of a child process for this module; keeps the test seam small. */
interface BackupChildProcess {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

type SpawnBackup = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => BackupChildProcess

export interface BackupSubprocessOptions {
  dataDir: string
  outputDir: string
  /** Shared blob mirror for the schedule; absent keeps the backup self-contained. */
  mirrorRoot?: string
  env?: NodeJS.ProcessEnv
  spawnBackup?: SpawnBackup
}

/**
 * Which program to run, mirroring how the daemon already spawns itself.
 *
 * The development branch is not decoration: without it the scheduled backup
 * would be the one path that never runs outside a packaged build, and a first
 * failure there is the expensive kind.
 */
export function buildBackupSpawnArgs(options: {
  env: NodeJS.ProcessEnv
  dataDir: string
  outputDir: string
  mirrorRoot?: string
}): { command: string; args: string[] } {
  const { env, dataDir, outputDir, mirrorRoot } = options
  // Inline form only — the CLI rejects the space form outright, to stop a
  // missing value silently swallowing the next token.
  const cliArgs = [
    'server',
    'backup',
    '--json',
    `--data-dir=${dataDir}`,
    `--output-dir=${outputDir}`,
    ...(mirrorRoot ? [`--mirror-dir=${mirrorRoot}`] : []),
  ]
  if (env.WHITEBOARD_DEV === '1') {
    return {
      command: process.execPath,
      args: ['--import', 'tsx/esm', join(WHITEBOARD_ROOT, 'src/cli/index.ts'), ...cliArgs],
    }
  }
  return {
    command: process.execPath,
    args: [join(WHITEBOARD_ROOT, 'dist/cli/index.js'), ...cliArgs],
  }
}

/**
 * Run one backup in a child process and report what it said.
 *
 * Anything other than a zero exit carrying a result this package's own schema
 * accepts is an ERROR. A zero exit with unreadable output would otherwise be
 * reported as a backup that may not exist, which is the defect this whole
 * area exists to remove, arriving by simply not checking.
 */
export async function runBackupInSubprocess(
  options: BackupSubprocessOptions,
): Promise<ServerBackupOutcome> {
  const { dataDir, outputDir, mirrorRoot } = options
  const env = options.env ?? process.env
  const spawnBackup: SpawnBackup =
    options.spawnBackup ??
    ((command, args, opts) =>
      spawn(command, [...args], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }))

  const { command, args } = buildBackupSpawnArgs({
    env,
    dataDir,
    outputDir,
    ...(mirrorRoot ? { mirrorRoot } : {}),
  })

  let child: BackupChildProcess
  try {
    // The child inherits this process's environment, which is what carries
    // `WHITEBOARD_DATABASE_URL` and its credentials — the CLI has to reach
    // the same rows. The directories are passed as arguments rather than left
    // to that environment, since a backup of the wrong directory reports
    // success exactly as loudly as a backup of the right one.
    child = spawnBackup(command, args, { env })
  } catch (err) {
    log.error({ err }, 'could not start the backup process')
    return { kind: 'error', message: 'backup failed' }
  }

  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  }).catch((err: Error) => {
    log.error({ err }, 'the backup process could not be run')
    return null
  })

  const [out, errText] = await Promise.all([stdout, stderr])

  if (code !== 0) {
    // The CLI's failure text is prose for an operator and names no secret;
    // it is the most useful thing this process knows about the failure.
    log.error({ code, detail: errText.trim().slice(0, 500) }, 'the backup process failed')
    return { kind: 'error', message: 'backup failed' }
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(out)
  } catch {
    log.error({}, 'the backup process exited cleanly but printed no readable result')
    return { kind: 'error', message: 'backup failed' }
  }
  const result = serverBackupResultSchema.safeParse(parsedJson)
  if (!result.success) {
    log.error({}, 'the backup process printed a result this version does not understand')
    return { kind: 'error', message: 'backup failed' }
  }
  return { kind: 'ok', result: result.data }
}

async function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return ''
  const chunks: string[] = []
  stream.setEncoding('utf8')
  for await (const chunk of stream) chunks.push(String(chunk))
  return chunks.join('')
}
