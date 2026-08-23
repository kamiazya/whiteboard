// Dispatcher for the `whiteboard` CLI. Lives apart from `cli/index.ts`
// (which is the bin entrypoint and auto-invokes `main()` on load) so
// tests can import this module without triggering side-effects from
// the entrypoint's argv parse + `process.exit` chain.
//
// Output contract:
//   stdout  -> exactly one JSON object terminated by '\n', EXCEPT:
//              - `--version` / `-v` emits a bare semver string (not JSON)
//              - `logs` emits JSONL (one redacted JSON entry per line,
//                trailing newline)
//   stderr  -> diagnostics / usage / errors only
//
// `run` is dispatched via a dynamic import so the read-only commands
// (`status`, `doctor`, `stop`, `logs`) never pull in `server/config`
// (which mkdirs on load) or the rest of the daemon startup chain.

import { resolve } from 'node:path'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { applyConfigFileToEnvAndLogLevel, loadConfigFile } from '../server/config-file.js'
import { getLogger } from '../server/log.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import {
  parseDaemonRunArgs,
  parseDaemonSubcommandArgs,
  parseDaemonSupportBundleArgs,
} from './argv.js'
import { runDaemonDoctor } from './daemon-doctor.js'
import { runDaemonLogs } from './daemon-logs.js'
import { runDaemonStatus } from './daemon-status.js'
import { runDaemonStop } from './daemon-stop.js'
import { runDaemonSupportBundle } from './daemon-support-bundle.js'
import { parseServerBackupArgs } from './server-backup-args.js'
import { parseServerLifecycleArgs } from './server-lifecycle-args.js'
import { parseServerRestoreArgs } from './server-restore-args.js'
import { parseServerRunArgs } from './server-run-args.js'
import { parseServerSupportBundleArgs } from './server-support-bundle-args.js'

export const USAGE = `whiteboard --version | -v
whiteboard mcp
whiteboard daemon status         --json [--data-dir=<path>]
whiteboard daemon doctor         --json [--data-dir=<path>]
whiteboard daemon stop           --json [--data-dir=<path>]
whiteboard daemon logs           --json [--data-dir=<path>]
whiteboard daemon support-bundle --json --output-dir=<path> [--data-dir=<path>]
whiteboard daemon run            --json [--host=<host>] [--port=<port>] [--data-dir=<path>] [--token-stdin | WHITEBOARD_DAEMON_TOKEN env] [--no-open]
whiteboard server status         --json [--data-dir=<path>]
whiteboard server doctor         --json [--external-url=<url>] [--auth-strategy=oauth-jwt] [--jwt-issuer=<url>] [--jwt-audience=<aud>] [--jwks-uri=<url>] [options...]
whiteboard server stop           --json [--data-dir=<path>]
whiteboard server run            --json --dry-run [--external-url=<url>] [--auth-strategy=oauth-jwt] [--jwt-issuer=<url>] [--jwt-audience=<aud>] [--jwks-uri=<url>] [options...]
whiteboard server backup         --json --output-dir=<path> [--data-dir=<path>]
whiteboard server restore        --json --backup-dir=<path> --target-dir=<path>
whiteboard server support-bundle --json --output-dir=<path> [--data-dir=<path>]
whiteboard search fetch-model    --json [--data-dir=<path>]
`

function writeJsonObject(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export async function main(argv: readonly string[]): Promise<number> {
  // no-arg: published MCP configs invoke the package as
  // `npx -y @kamiazya/whiteboard-mcp@latest` with no subcommand.
  // Preserve the original stdio-MCP behavior for backward compatibility.
  if (argv.length === 0) {
    return await dispatchMcp()
  }

  // Handle --version / -v anywhere in argv so the flag works regardless
  // of position and never falls through to the unknown-command path.
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${PACKAGE_VERSION}\n`)
    return 0
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

  if (
    command !== 'daemon' ||
    (subcommand !== 'status' &&
      subcommand !== 'doctor' &&
      subcommand !== 'stop' &&
      subcommand !== 'logs' &&
      subcommand !== 'support-bundle' &&
      subcommand !== 'run')
  ) {
    process.stderr.write(`Unknown command. Currently supported:\n  ${USAGE}`)
    return 64
  }

  if (subcommand === 'run') {
    return await dispatchRun(rest)
  }

  if (subcommand === 'support-bundle') {
    return await dispatchSupportBundle(rest)
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

  if (subcommand === 'status') {
    const { result, exitCode } = await runDaemonStatus({ dataDir })
    writeJsonObject(result)
    return exitCode
  }

  if (subcommand === 'doctor') {
    const { result, exitCode } = await runDaemonDoctor({ dataDir })
    writeJsonObject(result)
    return exitCode
  }

  if (subcommand === 'logs') {
    // `logs` emits JSONL — write the formatted stream verbatim,
    // do NOT route it through `writeJsonObject` (which would wrap
    // the JSONL stream with an extra trailing newline and break
    // the one-line-per-entry contract for downstream consumers).
    const { stdout, stderr, exitCode } = await runDaemonLogs({ dataDir })
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    return exitCode
  }

  // subcommand === 'stop'
  const { result, exitCode } = await runDaemonStop({ dataDir })
  writeJsonObject(result)
  return exitCode
}

async function dispatchMcp(): Promise<number> {
  // Long-running stdio MCP server. stdout is the JSON-RPC stream and
  // MUST stay free of human-readable usage text, daemon JSON, or
  // anything emitted via `writeJsonObject`. Errors during startup
  // surface on stderr only, then the process exits non-zero.
  // Dynamic import keeps the MCP module (and its server/config
  // mkdir + daemon side effects) out of the read-only command path.
  const { main: runMcp } = await import('../server/mcp/index.js')
  try {
    await runMcp()
  } catch (err) {
    // Raw `err.message` from the MCP startup chain may carry local
    // paths / tokens / stack frames (e.g. a libsql open error
    // echoes `file:/Users/<name>/.../whiteboard.db`). Run it through
    // the shared redactor so even the stderr surface — which is the
    // only diagnostic channel `whiteboard mcp` exposes — never leaks
    // those classes of strings.
    const { redactDiagnosticText } = await import('../shared/diagnostics/redact.js')
    const raw = err instanceof Error ? err.message : String(err)
    // Two-pass scrub:
    //   - shared redactor scrubs token values, paths, stack frames
    //   - the local auth-marker pass drops the literal "Authorization"
    //     / "Bearer" words. The shared redactor preserves those on
    //     purpose for the doctor surface, but the MCP stderr surface
    //     is consumed by clients tailing logs that grep for those
    //     keywords; even the redacted marker is unwelcome there.
    const redacted = redactDiagnosticText(raw)
      .replace(/(?:Authorization\s*:\s*)?\bBearer\s*\[REDACTED\]/gi, '[REDACTED_AUTH]')
      .replace(/Authorization\s*:\s*\[REDACTED\]/gi, '[REDACTED_AUTH]')
    process.stderr.write(`MCP server error: ${redacted}\n`)
    return 1
  }
  // Never resolves from this dispatcher's point of view: the stdio
  // lifecycle installed inside `runMcp()` (see stdio-lifecycle.ts) calls
  // process.exit() directly on stdin EOF/close/error or SIGTERM/SIGINT,
  // so control never actually returns here — it exits the process instead.
  return await new Promise<never>(() => undefined)
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
  const parsed = parseDaemonSubcommandArgs(rest, 'search fetch-model')
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
  })
  writeJsonObject(result)
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
  writeJsonObject(result)
  return exitCode
}

async function dispatchServerRun(rest: readonly string[]): Promise<number> {
  const parsed = parseServerRunArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  // Dynamic import keeps server-mode dependencies (planServerModeAuth chain)
  // out of the read-only command path.
  const { runServerRun } = await import('./server-run.js')
  const outcome = await runServerRun({ flags: parsed, env: process.env })
  switch (outcome.kind) {
    case 'dry-run-ok':
      writeJsonObject(outcome.result)
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
      writeJsonObject(outcome.result)
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
  writeJsonObject(result)
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
  writeJsonObject(result)
  return exitCode
}

async function dispatchServerBackup(rest: readonly string[]): Promise<number> {
  const parsed = parseServerBackupArgs(rest)
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  const { runServerBackup } = await import('./server-backup.js')
  const outcome = await runServerBackup({ args: parsed, env: process.env })
  switch (outcome.kind) {
    case 'ok':
      writeJsonObject(outcome.result)
      return 0
    case 'running-server':
      process.stderr.write(
        'backup refused: server is running. Stop the server before taking a backup.\n',
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
  const outcome = await runServerRestore({ args: parsed })
  switch (outcome.kind) {
    case 'ok':
      writeJsonObject(outcome.result)
      return 0
    case 'running-target':
      process.stderr.write(
        'restore refused: target is a running server. Stop the server before restoring.\n',
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
  | { kind: 'ok'; port: number | undefined; openBrowser: boolean | undefined }
  | { kind: 'error'; message: string }

// Loads the nearest whiteboard config file (if any), layers its values
// under process.env (env-over-file precedence, see config-file.ts), logs
// the file path at info level, and returns the file's `port` and
// `openBrowser` (if set) so the caller can thread them into daemon-run's
// own precedence chains — neither is a simple set-if-unset env key like the
// other fields (port already had its own chain; openBrowser is a boolean
// with a `--no-open`-first override, not an env var at all).
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
  if (loaded === null) return { kind: 'ok', port: undefined, openBrowser: undefined }

  applyConfigFileToEnvAndLogLevel(loaded.config, process.env)
  getLogger('cli-dispatcher').info({ filepath: loaded.filepath }, 'loaded whiteboard config file')

  return { kind: 'ok', port: loaded.config.port, openBrowser: loaded.config.openBrowser }
}

async function dispatchRun(rest: readonly string[]): Promise<number> {
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
    process.env.WHITEBOARD_DATA_DIR = runDataDir
  }

  // Load+apply the config file AFTER the --data-dir env write above and
  // BEFORE the dynamic daemon-run import below, so file dataDir only wins
  // when neither --data-dir nor WHITEBOARD_DATA_DIR is already set, and the
  // shared/data-dir-secure.ts import-time DATA_DIR snapshot (pulled in via
  // daemon-run.js) sees the layered value. Config-file port is threaded
  // through separately (below) since --port and env don't share one seam.
  const configFileResult = applyLoadedConfigFileToDispatcherEnv()
  if (configFileResult.kind === 'error') {
    process.stderr.write(`${configFileResult.message}\n`)
    return 1
  }

  // Dynamic import keeps `server/config` (and its mkdirSync probe
  // at module load) out of the read-only command path.
  const { runDaemonRun } = await import('./daemon-run.js')
  const outcome = await runDaemonRun({
    host: parsed.host,
    port: parsed.port ?? configFileResult.port,
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
  // Ready: emit the JSON ready line, then keep the process alive
  // — installDaemonSignalHandlers (called from runDaemonRun) takes
  // over the lifecycle from here.
  writeJsonObject(outcome.result)
  // Best-effort UX on top of an already-successful startup: a browser that
  // fails to open (no display, sandboxed environment, …) must never affect
  // the ready-JSON contract or the daemon's exit code, so this runs after
  // the JSON line above and its own errors are only logged, never thrown.
  const { maybeOpenDaemonBrowser } = await import('./daemon-run-auto-open.js')
  await maybeOpenDaemonBrowser({
    host: outcome.result.host,
    port: outcome.result.port,
    noOpenFlag: parsed.noOpen,
    configOpenBrowser: configFileResult.openBrowser,
  })
  // Returning a Promise that never resolves keeps the caller's
  // top-level then-chain pinned, so process.exit isn't called
  // until SIGTERM/SIGINT lands and the signal handler exits 0.
  return await new Promise<never>(() => undefined)
}
