// Dispatcher for the `whiteboard` CLI. Lives apart from `cli/index.ts`
// (which is the bin entrypoint and auto-invokes `main()` on load) so
// tests can import this module without triggering side-effects from
// the entrypoint's argv parse + `process.exit` chain.
//
// Output contract:
//   stdout  -> exactly one JSON object terminated by '\n', EXCEPT:
//              - `--version` / `-v` emits a bare semver string (not JSON)
//              - `daemon run` without `--json` emits one line of prose: it is
//                the command a person types to start the daemon, and every
//                script that reads its ready line passes `--json`
//   stderr  -> diagnostics / usage / errors only
//
// `run` is dispatched via a dynamic import so the read-only commands
// (`status`, `doctor`, `stop`) never pull in `server/config`
// (which mkdirs on load) or the rest of the daemon startup chain.

import { resolve } from 'node:path'
import type { z } from 'zod'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { applyConfigFileToEnvAndLogLevel, loadConfigFile } from '../server/config-file.js'
import { getLogger } from '../server/log.js'
import { daemonDoctorResultSchema } from '../shared/api-contracts/daemon-doctor.js'
import {
  daemonRotateReplicaKeyResultSchema,
  daemonSetReplicaTierResultSchema,
} from '../shared/api-contracts/daemon-replica-posture.js'
import { daemonRunReadyResultSchema } from '../shared/api-contracts/daemon-run.js'
import { daemonStatusResultSchema } from '../shared/api-contracts/daemon-status.js'
import { daemonStopResultSchema } from '../shared/api-contracts/daemon-stop.js'
import { searchFetchModelOutputSchema } from '../shared/api-contracts/search-fetch-model.js'
import { serverStatusResultSchema } from '../shared/api-contracts/server-status.js'
import { serverStopResultSchema } from '../shared/api-contracts/server-stop.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import {
  parseDaemonReplicaKeyArgs,
  parseDaemonReplicaTierArgs,
  parseDaemonRunArgs,
  parseDaemonSubcommandArgs,
  parseDaemonSupportBundleArgs,
} from './argv.js'
import { runDaemonDoctor } from './daemon-doctor.js'
import { runDaemonRotateReplicaKey, runDaemonSetReplicaTier } from './daemon-replica-posture.js'
import { runDaemonStatus } from './daemon-status.js'
import { runDaemonStop } from './daemon-stop.js'
import { runDaemonSupportBundle } from './daemon-support-bundle.js'
import {
  operatorJsonLine,
  serverRestoreOutputSchema,
  serverRunDryRunOutputSchema,
  serverRunReadyOutputSchema,
} from './operator-json.js'
import { parseServerBackupArgs } from './server-backup-args.js'
import { parseServerLifecycleArgs } from './server-lifecycle-args.js'
import { parseServerRestoreArgs } from './server-restore-args.js'
import { parseServerRunArgs } from './server-run-args.js'
import { parseServerSupportBundleArgs } from './support-bundle-args.js'

export const USAGE = `whiteboard --version | -v
whiteboard mcp
whiteboard daemon status         --json [--data-dir=<path>]
whiteboard daemon doctor         --json [--data-dir=<path>]
whiteboard daemon stop           --json [--data-dir=<path>]
whiteboard daemon support-bundle --json --output-dir=<path> [--data-dir=<path>]
whiteboard daemon rotate-replica-key --json --workspace=<id|segment> [--data-dir=<path>]
whiteboard daemon set-replica-tier   --json --workspace=<id|segment> --tier=<no-offline|offline|bounded|default> [--data-dir=<path>]
whiteboard daemon run            [--json] [--data-dir=<path>] [--token-stdin | WHITEBOARD_DAEMON_TOKEN env] [--no-open]
whiteboard server status         --json [--data-dir=<path>]
whiteboard server doctor         --json [--external-url=<url>] [--auth-strategy=oauth-jwt] [--jwt-issuer=<url>] [--jwt-audience=<aud>] [--jwks-uri=<url>] [--allowed-origins=<csv>] [--jwt-clock-skew=<seconds>] [--jwt-scope-claim=<scope|scp>] [--host=<addr>] [--port=<1-65535>] [--data-dir=<path>]
whiteboard server stop           --json [--data-dir=<path>]
whiteboard server run            --json [--dry-run] [--external-url=<url>] [--auth-strategy=oauth-jwt] [--jwt-issuer=<url>] [--jwt-audience=<aud>] [--jwks-uri=<url>] [--allowed-origins=<csv>] [--jwt-clock-skew=<seconds>] [--jwt-scope-claim=<scope|scp>] [--host=<addr>] [--port=<1-65535>] [--data-dir=<path>]
whiteboard server backup         --json --output-dir=<path> [--data-dir=<path>]
whiteboard server restore        --json --backup-dir=<path> --target-dir=<path>
whiteboard server grant-member   --json --workspace=<id|segment> --user=<id|name> [--data-dir=<path>]
whiteboard server grant-admin    --json --user=<id|name> [--remove] [--data-dir=<path>]
whiteboard server deactivate-user --json --user=<id|name> [--reactivate] [--data-dir=<path>]
whiteboard server add-user       --json --provider=<id> --subject=<sub> [--name=<display name>] [--data-dir=<path>]
whiteboard server support-bundle --json --output-dir=<path> [--data-dir=<path>]
whiteboard search fetch-model    --json [--full] [--data-dir=<path>]
whiteboard native-host install   --json [--data-dir=<path>] [--manifest-dir=<path>] [--firefox-manifest-dir=<path>]
`

/** The one way an output reaches stdout: parsed by the schema that declares it. */
function writeJsonObject<S extends z.ZodType>(schema: S, value: z.input<S>): void {
  process.stdout.write(operatorJsonLine(schema, value))
}

/**
 * What `daemon` accepts. A set rather than a chain of `!==` comparisons, and
 * the type is read OFF it, so a subcommand added to one is added to both.
 */
const DAEMON_SUBCOMMANDS = [
  'status',
  'doctor',
  'stop',
  'support-bundle',
  'rotate-replica-key',
  'set-replica-tier',
  'run',
] as const
type DaemonSubcommand = (typeof DAEMON_SUBCOMMANDS)[number]
const isDaemonSubcommand = (value: string | undefined): value is DaemonSubcommand =>
  DAEMON_SUBCOMMANDS.includes(value as DaemonSubcommand)

/**
 * The subcommands whose whole job is to answer one JSON object. They differ
 * in nothing else, so they are a table rather than three identical blocks —
 * and `satisfies` is what keeps the table in step with the union above.
 */
const JSON_DAEMON_COMMANDS = {
  status: { run: runDaemonStatus, schema: daemonStatusResultSchema },
  doctor: { run: runDaemonDoctor, schema: daemonDoctorResultSchema },
  stop: { run: runDaemonStop, schema: daemonStopResultSchema },
} satisfies Record<
  Exclude<DaemonSubcommand, 'run' | 'support-bundle' | 'rotate-replica-key' | 'set-replica-tier'>,
  {
    run: (options: { dataDir: string }) => Promise<{ result: unknown; exitCode: number }>
    schema: z.ZodType
  }
>

/**
 * The commands that locate the LOCAL daemon by its data directory: the stdio
 * server, the `daemon` family, the extension's native host and the search
 * model cache the daemon reads. Server mode is configured by flags and
 * environment (a container's cwd holds no daemon config), so `server *` is
 * deliberately not here.
 */
function locatesLocalDaemon(argv: readonly string[]): boolean {
  const [command, subcommand] = argv
  if (argv.length === 0 || command === 'search' || command === 'native-host') return true
  if (command === 'mcp') return subcommand === undefined
  return command === 'daemon' && isDaemonSubcommand(subcommand)
}

export async function main(argv: readonly string[]): Promise<number> {
  // Handle --version / -v anywhere in argv so the flag works regardless
  // of position and never falls through to the unknown-command path.
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${PACKAGE_VERSION}\n`)
    return 0
  }

  // Only as the whole command line: `-h` after a subcommand is that
  // subcommand's own to interpret, and `mcp`'s stdout is a protocol channel.
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(USAGE)
    return 0
  }

  // Loaded once, here, for every command that locates the daemon by its data
  // directory: a file `dataDir` honoured by `daemon run` alone put the daemon
  // where no other command looked for it. Layered under process.env, so
  // flag > env > file > default holds for all of them.
  let configOpenBrowser: boolean | undefined
  if (locatesLocalDaemon(argv)) {
    const configFileResult = applyLoadedConfigFileToDispatcherEnv()
    if (configFileResult.kind === 'error') {
      process.stderr.write(`${configFileResult.message}\n`)
      return 1
    }
    configOpenBrowser = configFileResult.openBrowser
  }

  return await route(argv, configOpenBrowser)
}

async function route(
  argv: readonly string[],
  configOpenBrowser: boolean | undefined,
): Promise<number> {
  // no-arg: published MCP configs invoke the package as
  // `npx -y @kamiazya/whiteboard-mcp@latest` with no subcommand.
  // Preserve the original stdio-MCP behavior for backward compatibility.
  if (argv.length === 0) {
    return await dispatchMcp()
  }

  const [command, subcommand, ...rest] = argv

  // `whiteboard mcp` is the sole stdio MCP entrypoint. Route it
  // BEFORE the usage check below so the dispatcher does not run any
  // human-readable code paths that could leak text into MCP stdout.
  if (command === 'mcp' && subcommand === undefined) {
    return await dispatchMcp()
  }

  if (command === 'server') {
    return await dispatchServer(subcommand, rest)
  }

  if (command === 'search') {
    return await dispatchSearch(subcommand, rest)
  }

  // Before anything that could print: `native-host run`'s stdout is the
  // browser's protocol channel, as `mcp`'s is the client's.
  if (command === 'native-host') {
    const { dispatchNativeHost } = await import('./native-host.js')
    return await dispatchNativeHost(subcommand, rest)
  }

  if (command === 'daemon' && isDaemonSubcommand(subcommand)) {
    return await dispatchDaemon(subcommand, rest, configOpenBrowser).catch((err: unknown) =>
      reportDaemonRefusal(subcommand, err),
    )
  }

  process.stderr.write(`Unknown command. Currently supported:\n  ${USAGE}`)
  return 64
}

/**
 * The `daemon` family. Each subcommand is read-only about the filesystem —
 * the data directory is RESOLVED here and never probed for writability,
 * because mkdir and write probes belong to the daemon's startup path, not to
 * a command an operator runs to ask a question.
 */
/**
 * A refusal thrown from below — a daemon record this build cannot read or
 * interpret while its process may be running — is an answer for a person:
 * one stderr line and exit 1, never a stack trace, and stdout stays clean for
 * callers parsing its JSON. Line breaks are folded to a space because the
 * message names a path, which may hold one, and a second line would read as
 * a second report.
 */
function reportDaemonRefusal(subcommand: DaemonSubcommand, err: unknown): number {
  const message = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ')
  process.stderr.write(`whiteboard daemon ${subcommand}: ${message}\n`)
  return 1
}

async function dispatchDaemon(
  subcommand: DaemonSubcommand,
  rest: readonly string[],
  configOpenBrowser: boolean | undefined,
) {
  if (subcommand === 'run') {
    return await dispatchRun(rest, configOpenBrowser)
  }

  if (subcommand === 'support-bundle') {
    return await dispatchSupportBundle(rest)
  }

  if (subcommand === 'rotate-replica-key' || subcommand === 'set-replica-tier') {
    return await dispatchReplicaPosture(subcommand, rest)
  }

  const parsed = parseDaemonSubcommandArgs(rest, `daemon ${subcommand}`)
  if (parsed.kind === 'usage-error') {
    // stdout stays empty on usage errors so consumers that pipe
    // stdout into JSON.parse never see an unexpected payload.
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }

  // Read-only resolver: env override beats homedir(), and the
  // homedir candidate is NOT probed for writability. The CLI is
  // contractually side-effect-free; mkdir + write probes belong to
  // the daemon's startup path.
  const dataDir = parsed.dataDir ?? resolveDefaultDataDir(process.env)

  const command = JSON_DAEMON_COMMANDS[subcommand]
  const { result, exitCode } = await command.run({ dataDir })
  writeJsonObject(command.schema, result)
  return exitCode
}

async function dispatchMcp(): Promise<number> {
  // Long-running stdio MCP server. stdout is the JSON-RPC stream and
  // MUST stay free of human-readable usage text, daemon JSON, or
  // anything emitted via `writeJsonObject`. Errors during startup
  // surface on stderr only, then the process exits non-zero.
  // Dynamic import keeps the MCP module (and its server/config
  // mkdir + daemon side effects) out of the read-only command path.
  const { main: runMcp } = await import('../server/stdio-root.js')
  try {
    await runMcp()
  } catch (err) {
    // Raw `err.message` from the MCP startup chain may carry local
    // paths / tokens / stack frames (e.g. a libsql open error
    // echoes `file:/Users/<name>/.../whiteboard.db`). Run it through
    // the shared redactor so even the stderr surface — which is the
    // only diagnostic channel `whiteboard mcp` exposes — never leaks
    // those classes of strings.
    const { redactDiagnosticText, scrubAuthMarkers } = await import(
      '../shared/diagnostics/redact.js'
    )
    const raw = err instanceof Error ? err.message : String(err)
    // Two-pass scrub: the shared redactor takes token values, paths and stack
    // frames but keeps the `Authorization` / `Bearer` marker for the doctor
    // surface; this stderr surface is consumed by clients tailing logs that
    // grep for those keywords, so the marker goes too (`scrubAuthMarkers` is
    // the one definition of what counts as one).
    const redacted = scrubAuthMarkers(redactDiagnosticText(raw))
    process.stderr.write(`MCP server error: ${redacted}\n`)
    return 1
  }
  // Never resolves from this dispatcher's point of view: the stdio
  // lifecycle installed inside `runMcp()` (see stdio-lifecycle.ts) calls
  // process.exit() directly on stdin EOF/close/error or SIGTERM/SIGINT,
  // so control never actually returns here — it exits the process instead.
  return await new Promise<never>(() => undefined)
}

/**
 * The two posture commands ask the RUNNING daemon over its socket; the data
 * directory only locates its record. Both answer one JSON object.
 */
async function dispatchReplicaPosture(
  subcommand: 'rotate-replica-key' | 'set-replica-tier',
  rest: readonly string[],
): Promise<number> {
  const usageError = (message: string): number => {
    process.stderr.write(`${message}\n`)
    return 64
  }
  if (subcommand === 'rotate-replica-key') {
    const parsed = parseDaemonReplicaKeyArgs(rest)
    if (parsed.kind === 'usage-error') return usageError(parsed.message)
    const { result, exitCode } = await runDaemonRotateReplicaKey({
      dataDir: parsed.dataDir ?? resolveDefaultDataDir(process.env),
      workspaceId: parsed.workspaceId,
    })
    writeJsonObject(daemonRotateReplicaKeyResultSchema, result)
    return exitCode
  }
  const parsed = parseDaemonReplicaTierArgs(rest)
  if (parsed.kind === 'usage-error') return usageError(parsed.message)
  const { result, exitCode } = await runDaemonSetReplicaTier({
    dataDir: parsed.dataDir ?? resolveDefaultDataDir(process.env),
    workspaceId: parsed.workspaceId,
    tier: parsed.tier,
  })
  writeJsonObject(daemonSetReplicaTierResultSchema, result)
  return exitCode
}

async function dispatchSupportBundle(rest: readonly string[]): Promise<number> {
  const parsed = parseDaemonSupportBundleArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  const dataDir = parsed.dataDir ?? resolveDefaultDataDir(process.env)
  const outputDir = resolve(parsed.outputDir)
  const { stdout, stderr, exitCode } = await runDaemonSupportBundle({
    dataDir,
    outputDir,
  })
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return exitCode
}

async function dispatchSearch(
  subcommand: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (subcommand !== 'fetch-model') {
    process.stderr.write(`Unknown search subcommand. Currently supported:\n  ${USAGE}`)
    return 64
  }
  // --full is stripped before the shared parser sees it: that parser's job
  // is --json/--data-dir, and it rejects anything else by design.
  const full = rest.includes('--full')
  const parsed = parseDaemonSubcommandArgs(
    rest.filter((arg) => arg !== '--full'),
    'search fetch-model',
  )
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  // The daemon reads weights from the same place, and searchModelCacheDir
  // is that one definition. It lives apart from search-embedder.js so
  // naming it here does not drag in server/config, which mkdirs on load.
  const { searchModelCacheDir } = await import('../server/search/model-cache-dir.js')
  const dataDir = parsed.dataDir ?? resolveDefaultDataDir(process.env)
  const { runSearchFetchModel } = await import('./search-fetch-model.js')
  const { result, exitCode } = await runSearchFetchModel({
    cacheDir: searchModelCacheDir(dataDir),
    dtype: full ? 'fp32' : 'q8',
  })
  writeJsonObject(searchFetchModelOutputSchema, result)
  return exitCode
}

async function dispatchServer(
  subcommand: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (subcommand === 'run') {
    return await dispatchServerRun(rest)
  }
  if (subcommand === 'status') {
    return await dispatchServerStatus(rest)
  }
  if (subcommand === 'stop') {
    return await dispatchServerStop(rest)
  }
  if (subcommand === 'doctor') {
    return await dispatchServerDoctor(rest)
  }
  if (subcommand === 'backup') {
    return await dispatchServerBackup(rest)
  }
  if (subcommand === 'restore') {
    return await dispatchServerRestore(rest)
  }
  if (subcommand === 'support-bundle') {
    return await dispatchServerSupportBundle(rest)
  }
  if (subcommand === 'add-user') {
    const { runServerAddUser } = await import('./server-add-user.js')
    return await runServerAddUser(rest)
  }
  if (subcommand === 'grant-member') {
    // Dynamic import keeps the store out of the read-only command path.
    const { runServerGrantMember } = await import('./server-grant-member.js')
    return await runServerGrantMember(rest)
  }
  if (subcommand === 'grant-admin') {
    const { runServerGrantAdmin } = await import('./server-grant-admin.js')
    return await runServerGrantAdmin(rest)
  }
  if (subcommand === 'deactivate-user') {
    const { runServerDeactivateUser } = await import('./server-deactivate-user.js')
    return await runServerDeactivateUser(rest)
  }
  process.stderr.write(`Unknown server subcommand. Currently supported:\n  ${USAGE}`)
  return 64
}

async function dispatchServerDoctor(rest: readonly string[]): Promise<number> {
  const parsed = parseServerRunArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  // Dynamic import keeps server-mode dependencies out of the read-only command path.
  const { runServerDoctor } = await import('./server-doctor.js')
  const { result, exitCode } = await runServerDoctor({ flags: parsed, env: process.env })
  writeJsonObject(daemonDoctorResultSchema, result)
  return exitCode
}

async function dispatchServerRun(rest: readonly string[]): Promise<number> {
  const parsed = parseServerRunArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  // Dynamic import keeps server-mode dependencies (server-mode exposure chain)
  // out of the read-only command path.
  const { runServerRun } = await import('./server-run.js')
  const outcome = await runServerRun({ flags: parsed, env: process.env })
  switch (outcome.kind) {
    case 'dry-run-ok':
      writeJsonObject(serverRunDryRunOutputSchema, outcome.result)
      return 0
    case 'config-error':
      process.stderr.write(
        `server-mode config error: code=${outcome.code} field=${outcome.field}\n`,
      )
      return 1
    case 'plan-error':
      process.stderr.write(`server-mode config error: code=${outcome.code}\n`)
      return 1
    case 'start-error':
      process.stderr.write('server failed to start\n')
      return 1
    case 'running': {
      writeJsonObject(serverRunReadyOutputSchema, outcome.result)
      const gracefulShutdown = async () => {
        try {
          await outcome.close()
        } finally {
          process.exit(0)
        }
      }
      process.on('SIGTERM', () => {
        void gracefulShutdown()
      })
      process.on('SIGINT', () => {
        void gracefulShutdown()
      })
      return await new Promise<never>(() => undefined)
    }
  }
}

async function dispatchServerStatus(rest: readonly string[]): Promise<number> {
  const parsed = parseServerLifecycleArgs(rest, 'server status')
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  const dataDir = parsed.dataDir ?? resolveDefaultDataDir(process.env)
  const { runServerStatus } = await import('./server-status.js')
  const { result, exitCode } = await runServerStatus({ dataDir })
  writeJsonObject(serverStatusResultSchema, result)
  return exitCode
}

async function dispatchServerStop(rest: readonly string[]): Promise<number> {
  const parsed = parseServerLifecycleArgs(rest, 'server stop')
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  const dataDir = parsed.dataDir ?? resolveDefaultDataDir(process.env)
  const { runServerStop } = await import('./server-stop.js')
  const { result, exitCode } = await runServerStop({ dataDir })
  writeJsonObject(serverStopResultSchema, result)
  return exitCode
}

async function dispatchServerBackup(rest: readonly string[]): Promise<number> {
  const parsed = parseServerBackupArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  const { runServerBackup } = await import('./server-backup.js')
  const { serverBackupResultSchema } = await import('../server/store/backup-pass.js')
  const outcome = await runServerBackup({ args: parsed, env: process.env })
  switch (outcome.kind) {
    case 'ok':
      writeJsonObject(serverBackupResultSchema, outcome.result)
      // A store the product does not cover is named in words as well as in
      // the JSON (ADR-0021 decision 2). An operator reading a terminal should
      // not have to notice a nested `captured: false` to learn that their
      // rows are still their own responsibility. stdout stays pure JSON, so
      // this goes to stderr.
      if (!outcome.result.stores.database.captured) {
        process.stderr.write(
          'note: the database was not backed up — this deployment points ' +
            'WHITEBOARD_DATABASE_URL at a server we do not host, so its backups are ' +
            'yours to arrange. The blobs in the data directory were copied.\n',
        )
      }
      return 0
    case 'missing-database':
      process.stderr.write(
        'backup refused: this data directory is where the rows belong, and it has no ' +
          'database in it. Nothing here can be restored from.\n',
      )
      return 1
    case 'invalid-output-path':
      process.stderr.write('backup refused: output path is not an empty directory.\n')
      return 1
    case 'error':
      process.stderr.write('backup failed\n')
      return 1
  }
}

async function dispatchServerRestore(rest: readonly string[]): Promise<number> {
  const parsed = parseServerRestoreArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  const { runServerRestore } = await import('./server-restore.js')
  const outcome = await runServerRestore({ args: parsed, env: process.env })
  switch (outcome.kind) {
    case 'ok':
      writeJsonObject(serverRestoreOutputSchema, outcome.result)
      return 0
    case 'running-target':
      process.stderr.write(
        'restore refused: target is a running server. Stop the server before restoring.\n',
      )
      return 1
    case 'external-database':
      process.stderr.write(
        'restore refused: this backup and this target disagree about where the rows ' +
          'live. A backup taken from a deployment that keeps its rows in the data ' +
          'directory can only be restored into another one, and the same holds for a ' +
          'backup whose rows were hosted elsewhere. Restoring across that change is not ' +
          'supported yet.\n',
      )
      return 1
    case 'invalid-target-path':
      process.stderr.write('restore refused: target path is not an empty directory.\n')
      return 1
    case 'error':
      process.stderr.write('restore failed\n')
      return 1
  }
}

async function dispatchServerSupportBundle(rest: readonly string[]): Promise<number> {
  const parsed = parseServerSupportBundleArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  const dataDir = resolve(parsed.dataDir ?? resolveDefaultDataDir(process.env))
  const outputDir = resolve(parsed.outputDir)
  const { runServerSupportBundle } = await import('./server-support-bundle.js')
  const { stdout, stderr, exitCode } = await runServerSupportBundle({
    dataDir,
    outputDir,
    env: process.env,
  })
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return exitCode
}

type ConfigFileEnvResult =
  | { kind: 'ok'; openBrowser: boolean | undefined }
  | { kind: 'error'; message: string }

// Loads the nearest whiteboard config file (if any), layers its values
// under process.env (env-over-file precedence, see config-file.ts), logs
// the file path at info level, and returns the file's `openBrowser` (if set)
// so `main` can thread it into daemon-run's own precedence chain — it is
// a boolean with a `--no-open`-first override, not an env var at all.
// loadConfigFile throws on a malformed file (by design, see config-file.ts);
// that throw is caught here and turned into the same structured
// stderr + exit-1 contract every other startup validation failure in this
// dispatcher follows, instead of an unhandled rejection with a raw stack.
function applyLoadedConfigFileToDispatcherEnv(): ConfigFileEnvResult {
  let loaded: ReturnType<typeof loadConfigFile>
  try {
    loaded = loadConfigFile()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'error', message: `whiteboard config file error: ${message}` }
  }
  if (loaded === null) return { kind: 'ok', openBrowser: undefined }

  applyConfigFileToEnvAndLogLevel(loaded.config, process.env)
  getLogger('cli-dispatcher').info({ filepath: loaded.filepath }, 'loaded whiteboard config file')

  return { kind: 'ok', openBrowser: loaded.config.openBrowser }
}

function describeDaemonReady(ready: z.infer<typeof daemonRunReadyResultSchema>): string {
  return `whiteboard daemon ${ready.version} is running (pid ${ready.pid}, socket ${ready.socketPath}). Stop it with: whiteboard daemon stop --json`
}

async function dispatchRun(
  rest: readonly string[],
  configOpenBrowser: boolean | undefined,
): Promise<number> {
  const parsed = parseDaemonRunArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  // Resolve the requested data dir to a single absolute path used
  // EVERYWHERE downstream — the env propagation that
  // `server/config.ts` reads, the daemon record we save, and the
  // ready JSON we emit. Without this, a relative `--data-dir`
  // would land in the env as absolute (via `resolve`) but stay
  // relative in the helper call, leaving record / ready JSON
  // disagreeing with `runtime.storage.dataDir`.
  const runDataDir = parsed.dataDir === undefined ? undefined : resolve(parsed.dataDir)
  if (runDataDir !== undefined) {
    // Overwrites what `main` layered from the file (and any env value), so
    // the flag wins over both.
    process.env.WHITEBOARD_DATA_DIR = runDataDir
  }

  // Dynamic import keeps `server/config` (and its mkdirSync probe
  // at module load) out of the read-only command path.
  const { runDaemonRun } = await import('./daemon-run.js')
  const outcome = await runDaemonRun({
    dataDir: runDataDir,
    tokenStdin: parsed.tokenStdin,
  })
  if (outcome.kind === 'input-error') {
    process.stderr.write(`${outcome.message}\n`)
    return 1
  }
  if (outcome.kind === 'refused') {
    process.stderr.write(`${outcome.message}\n`)
    return 1
  }
  // Ready: emit the JSON ready line, then stay up until the server closes.
  if (parsed.json) writeJsonObject(daemonRunReadyResultSchema, outcome.result)
  else process.stdout.write(`${describeDaemonReady(outcome.result)}\n`)
  // Best-effort UX on top of an already-successful startup: a browser that
  // fails to open (no display, sandboxed environment, …) must never affect
  // the ready-JSON contract or the daemon's exit code, so this runs after
  // the JSON line above and its own errors are only logged, never thrown.
  const { maybeOpenDaemonBrowser } = await import('./daemon-run-auto-open.js')
  await maybeOpenDaemonBrowser({
    noOpenFlag: parsed.noOpen,
    configOpenBrowser,
  })
  // A signal's handler exits the process itself; only the server's own idle
  // close comes back here, and it is a clean stop rather than a failure.
  if ((await outcome.stopped) === 'idle') {
    process.stderr.write('whiteboard daemon stopped: no request within its idle timeout.\n')
  }
  return 0
}
