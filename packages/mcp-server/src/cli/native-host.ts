// `whiteboard native-host` — ADR-0050's relay between the whiteboard
// extension and the local daemon.
//
//   run      what the browser starts. stdout IS the protocol channel, so
//            nothing else may ever be written there.
//   install  writes the launcher and each installed browser's manifest, and
//            answers one JSON object.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { loadDaemonRecord } from '../daemon/daemon-registry.js'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { installNativeHost, nativeHostManifestDirs } from '../daemon/native-host/install.js'
import { runNativeHost } from '../daemon/native-host/relay.js'
import { type FlagTable, scanFlags } from './flag-table.js'

const INSTALL_FLAGS: FlagTable<'dataDir' | 'manifestDir'> = {
  booleans: ['--json'],
  values: { '--data-dir': 'dataDir', '--manifest-dir': 'manifestDir' },
}

export async function dispatchNativeHost(
  subcommand: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (subcommand === 'run') return await runHost()
  if (subcommand === 'install') return await install(rest)
  process.stderr.write(
    'Unknown native-host subcommand. Use: whiteboard native-host install --json [--data-dir=<path>] [--manifest-dir=<path>]\n',
  )
  return 64
}

async function runHost(): Promise<number> {
  // The browser passes the extension's origin (and, on Windows, a window
  // handle); the manifest already restricts who may start the host, so
  // neither is read.
  const dataDir = resolveDefaultDataDir(process.env)
  await runNativeHost({
    input: process.stdin,
    output: process.stdout,
    resolveDaemon: async () => {
      const record = await loadDaemonRecord(dataDir).catch(() => null)
      return record?.socketPath ? { socketPath: record.socketPath, token: record.token } : null
    },
  })
  return 0
}

/**
 * The browser starts the launcher from a directory of its own choosing, so a
 * loader named by package (`--import tsx/esm`, when `whiteboard` itself runs
 * from source) is resolved here, from the package that has it.
 */
function portableExecArgv(execArgv: readonly string[]): string[] {
  return execArgv.map((arg, i) =>
    execArgv[i - 1] === '--import' && !isAbsolute(arg) && !arg.startsWith('file:')
      ? import.meta.resolve(arg)
      : arg,
  )
}

async function install(rest: readonly string[]): Promise<number> {
  const scan = scanFlags(rest, INSTALL_FLAGS)
  if (scan.kind === 'usage-error') {
    process.stderr.write(`${scan.message}\n`)
    return 64
  }
  if (!scan.seen.has('--json')) {
    process.stderr.write(
      'Only --json is supported. Re-run with: whiteboard native-host install --json\n',
    )
    return 64
  }
  const dataDir = resolve(scan.values.dataDir ?? resolveDefaultDataDir(process.env))
  const manifestDirs = scan.values.manifestDir
    ? [{ browser: 'explicit', dir: resolve(scan.values.manifestDir) }]
    : nativeHostManifestDirs(homedir(), process.platform)
  const result = await installNativeHost({
    dataDir,
    manifestDirs,
    launcher: {
      execPath: process.execPath,
      execArgv: portableExecArgv(process.execArgv),
      entry: realpathSync(process.argv[1] ?? ''),
    },
  })
  const ok = result.manifests.length > 0
  const reason = ok ? {} : { reason: 'no Chromium browser was found; pass --manifest-dir=<path>' }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok, ...reason, ...result })}\n`)
  return ok ? 0 : 1
}
