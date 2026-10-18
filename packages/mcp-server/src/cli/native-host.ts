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
import type { z } from 'zod'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { resolveDaemonEndpoint } from '../daemon/native-host/daemon-endpoint.js'
import {
  installNativeHost,
  type ManifestDir,
  NativeHostInstallIncompleteError,
  nativeHostManifestDirs,
} from '../daemon/native-host/install.js'
import { runNativeHost } from '../daemon/native-host/relay.js'
import { getLogger } from '../server/log.js'
import { type FlagTable, scanFlags } from './flag-table.js'
import {
  nativeHostInstallOutputSchema,
  OPERATOR_JSON_SCHEMA_VERSION,
  operatorJsonLine,
} from './operator-json.js'

const log = getLogger('native-host')

/**
 * The host answers a browser that cannot restart it mid-request, and a
 * rejection nothing awaited would end the process and every request in flight.
 * Logged on stderr, never stdout: stdout is the protocol channel.
 */
export function keepHostAliveOnUnhandledRejection(): () => void {
  const onRejection = (reason: unknown) => {
    log.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandled rejection in the native host',
    )
  }
  process.on('unhandledRejection', onRejection)
  return () => process.off('unhandledRejection', onRejection)
}

const INSTALL_FLAGS: FlagTable<'dataDir' | 'manifestDir' | 'firefoxManifestDir'> = {
  booleans: ['--json', '--development'],
  values: {
    '--data-dir': 'dataDir',
    '--manifest-dir': 'manifestDir',
    '--firefox-manifest-dir': 'firefoxManifestDir',
  },
}

const INSTALL_USAGE =
  'whiteboard native-host install --json [--development] [--data-dir=<path>] [--manifest-dir=<path>] [--firefox-manifest-dir=<path>]'

export async function dispatchNativeHost(
  subcommand: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (subcommand === 'run') return await runHost()
  if (subcommand === 'install') return await install(rest)
  process.stderr.write(`Unknown native-host subcommand. Use: ${INSTALL_USAGE}\n`)
  return 64
}

async function runHost(): Promise<number> {
  // The browser passes the extension's origin (and, on Windows, a window
  // handle); the manifest already restricts who may start the host, so
  // neither is read.
  const dataDir = resolveDefaultDataDir(process.env)
  const release = keepHostAliveOnUnhandledRejection()
  try {
    await runNativeHost({
      input: process.stdin,
      output: process.stdout,
      resolveDaemon: () => resolveDaemonEndpoint(dataDir),
    })
  } finally {
    release()
  }
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

/**
 * `npx` unpacks a package into a cache directory it replaces on the next
 * release, and the launcher pins the entry's absolute path, so a host
 * installed from there stops working at the next `npx @latest`. Said on
 * stderr, beside the JSON answer, rather than refused: the install is correct
 * until that day.
 */
function transientInstallWarning(entry: string): string | undefined {
  if (!/[\\/]_npx[\\/]/.test(entry)) return undefined
  return `whiteboard native-host install: this launcher points into npx's cache (${entry}), which npx replaces on a new release. Install the package globally (npm install -g @kamiazya/whiteboard-mcp) and run \`whiteboard native-host install --json\` from that install.\n`
}

/** The directories the user named, else wherever each installed browser looks. */
function chooseManifestDirs(
  dataDir: string,
  { manifestDir, firefoxManifestDir }: { manifestDir?: string; firefoxManifestDir?: string },
): ManifestDir[] {
  const explicit: ManifestDir[] = [
    ...(manifestDir
      ? [{ browser: 'explicit', engine: 'chromium', dir: resolve(manifestDir) } as const]
      : []),
    ...(firefoxManifestDir
      ? [{ browser: 'explicit', engine: 'firefox', dir: resolve(firefoxManifestDir) } as const]
      : []),
  ]
  return explicit.length > 0
    ? explicit
    : nativeHostManifestDirs(homedir(), process.platform, dataDir)
}

/**
 * Whether the install was told where to write. A development install anywhere
 * else would replace the registration each browser's everyday profile relies
 * on, and the development build admits loopback pages any user of the machine
 * can serve.
 */
function namesManifestDir(values: { manifestDir?: string; firefoxManifestDir?: string }): boolean {
  return values.manifestDir !== undefined || values.firefoxManifestDir !== undefined
}

const DEVELOPMENT_NEEDS_DIR =
  'whiteboard native-host install --development registers only into a directory you name: pass --manifest-dir=<path> or --firefox-manifest-dir=<path> (a throwaway profile, never an everyday one).\n'

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
  const development = scan.seen.has('--development')
  if (development && !namesManifestDir(scan.values)) {
    process.stderr.write(DEVELOPMENT_NEEDS_DIR)
    return 64
  }
  const dataDir = resolve(scan.values.dataDir ?? resolveDefaultDataDir(process.env))
  const manifestDirs = chooseManifestDirs(dataDir, scan.values)
  const entry = realpathSync(process.argv[1] ?? '')
  const transient = transientInstallWarning(entry)
  if (transient !== undefined) process.stderr.write(transient)
  return await installAndAnswer({
    dataDir,
    manifestDirs,
    launcher: {
      execPath: process.execPath,
      execArgv: portableExecArgv(process.execArgv),
      entry,
    },
    extensionBuild: development ? 'development' : 'production',
  })
}

async function installAndAnswer(options: Parameters<typeof installNativeHost>[0]): Promise<number> {
  let result: Awaited<ReturnType<typeof installNativeHost>>
  try {
    result = await installNativeHost(options)
  } catch (err) {
    // A refusal is an answer the `--json` reader parses, not a crash. One
    // that came after the launcher was written names it and every manifest
    // already in place, so the answer says what is on disk; a refused data
    // dir or launcher wrote nothing, and names nothing.
    const reason = err instanceof Error ? err.message : String(err)
    if (err instanceof NativeHostInstallIncompleteError) {
      return answerInstall({
        ok: false,
        reason,
        launcher: err.launcher,
        manifests: [...err.manifests],
      })
    }
    return answerInstall({ ok: false, reason, manifests: [] })
  }
  const ok = result.manifests.length > 0
  const reason = ok
    ? {}
    : {
        reason:
          'no Chromium browser or Firefox was found; pass --manifest-dir=<path> or --firefox-manifest-dir=<path>',
      }
  return answerInstall({ ok, ...reason, ...result })
}

function answerInstall(
  answer: Omit<z.input<typeof nativeHostInstallOutputSchema>, 'schemaVersion'>,
): number {
  process.stdout.write(
    operatorJsonLine(nativeHostInstallOutputSchema, {
      schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
      ...answer,
    }),
  )
  return answer.ok ? 0 : 1
}
