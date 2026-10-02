#!/usr/bin/env node
import { messageOf } from '@kamiazya/whiteboard-model'
import { deleteDaemonRecord, saveDaemonRecord } from '../daemon/daemon-registry.js'
import { daemonSocketPath } from '../daemon/daemon-socket.js'
import { describeEnvIssues } from '../shared/env-setting.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { getDataDir } from './config.js'
import { applyConfigFileToEnvAndLogLevel, loadConfigFile } from './config-file.js'
import { startHttpServer } from './http-server.js'
import { getLogger } from './log.js'
import { resolveReplicaEnv } from './replica-env.js'
import { resolveMcpProtectedResourceMetadataFromEnv } from './security/mcp-auth.js'
import { collectStartupEnvIssues } from './startup-env.js'

/**
 * Reads a `--name=value` flag out of an argv list. When the same flag is
 * passed more than once, `Array.prototype.find` returns the FIRST match, so a
 * caller's own value wins over one a wrapper appends later.
 */
export function parseArg(
  argv: readonly string[],
  name: string,
  fallback?: string,
): string | undefined {
  const prefix = `--${name}=`
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function readArg(name: string, fallback?: string): string | undefined {
  return parseArg(process.argv, name, fallback)
}

/**
 * Resolves the bearer token from CLI args then env.
 * --token=<value> takes precedence so packaged scripts that bake in a
 * default value work predictably; WHITEBOARD_TOKEN lets the daemon and
 * whatever spawned it stay in sync from a single shell export.
 */
export function resolveToken(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  // Use the LAST --token= flag so that a caller appending an explicit token
  // after a baked-in script default (e.g. pnpm mcp:http:dev already bakes in
  // --token=whiteboard-dev) gets the override honoured without having to
  // rewrite the entire argv array. slice() is used instead of split('=')[1]
  // so that token values containing '=' are preserved in full.
  const prefix = '--token='
  const match = [...argv].reverse().find((arg) => arg.startsWith(prefix))
  return match !== undefined ? match.slice(prefix.length) : env.WHITEBOARD_TOKEN
}

export { createApp } from './app.js'
export { startHttpServer } from './http-server.js'

// Loads the nearest whiteboard config file (if any) and layers its values
// under process.env before any other startup reads (allowlist, token,
// logLevel). Must run first: log.ts freezes its level at import time, so a
// file-provided logLevel needs the explicit setLogLevel call below, and
// every other env reader in this function reads process.env directly.
// dataDir is deliberately NOT applied here — DATA_DIR (shared/data-dir-secure.ts)
// is a static-import-time snapshot on this entrypoint, so a file dataDir key
// would be silently too-late; warn instead of pretending it worked.
//
// loadConfigFile throws on a malformed file (by design). Catch it here and
// fail the same way the startup-settings gate below does
// (structured getLogger record + process.exit(1)) instead of letting the
// throw propagate to the generic top-level `main().catch` at the bottom of
// this file, which would echo the raw error/stack on stderr unredacted.
function applyLoadedConfigFileForServerEntrypoint(): void {
  let loaded: ReturnType<typeof loadConfigFile>
  try {
    loaded = loadConfigFile()
  } catch (err) {
    const message = messageOf(err, String(err))
    getLogger('server-index').error(
      { message },
      'invalid whiteboard config file; refusing to start',
    )
    process.exit(1)
  }
  if (loaded === null) return

  // dataDir is dropped before applying: DATA_DIR (shared/data-dir-secure.ts)
  // was resolved at module import time on this entrypoint, so writing the
  // file value into the env would hand later env readers a dataDir the
  // running server is not actually using.
  const { dataDir: _ignoredDataDir, ...applicableConfig } = loaded.config
  applyConfigFileToEnvAndLogLevel(applicableConfig, process.env)
  const log = getLogger('server-index')
  log.info({ filepath: loaded.filepath }, 'loaded whiteboard config file')

  if (loaded.config.dataDir !== undefined) {
    log.warning(
      { filepath: loaded.filepath },
      'config file dataDir is not honored on this entrypoint; set WHITEBOARD_DATA_DIR instead',
    )
  }
}

/**
 * Every fail-fast configuration check this entrypoint makes, before any
 * tracing / store / server wiring exists to be half-built.
 *
 * The posture is uniform and deliberate: a setting the process cannot honour
 * aborts rather than starting on a default. `1h` on a grace window silently
 * meant one millisecond, and a misspelled log level silently meant `warning`
 * for someone who asked for `debug` to investigate an incident. Every bad
 * variable is named at once, so one restart is enough to fix them all.
 */
function checkStartupConfig(): void {
  const log = getLogger('server-index')
  const startupIssues = collectStartupEnvIssues(getDataDir(), process.env)
  if (startupIssues.length > 0) {
    log.error(
      { issues: describeEnvIssues(startupIssues) },
      'configured settings could not be understood; refusing to start',
    )
    process.exit(1)
  }
}

/**
 * Warm the headless renderer in the background so the first export does not
 * pay the font-parse + resvg-import startup cost. Best-effort by design.
 *
 * The dynamic import is inside the try, not just the call: a module
 * resolution or load failure would reject before the daemon binds, and an
 * unguarded `await import(...)` would take the whole process down — the
 * opposite of best-effort, for a warm-up the daemon does not need in order
 * to serve.
 *
 * Only the failure CLASS is logged: an ERR_MODULE_NOT_FOUND message carries
 * absolute paths, and the distribution smoke asserts the daemon never leaks
 * one to stderr.
 */
async function prewarmExporter(): Promise<void> {
  try {
    const { prewarmHeadlessExporter } = await import('./export/headless-renderer.js')
    // prewarmHeadlessExporter resolves on failure by contract — it logs its
    // own sanitized warning — so this catch is a net for a future contract
    // change, not the handler for a build error.
    prewarmHeadlessExporter().catch((err) => {
      getLogger('server-index').warning(
        { reason: err instanceof Error ? err.name : 'unknown' },
        'headless exporter pre-warm rejected unexpectedly',
      )
    })
  } catch (err) {
    getLogger('server-index').warning(
      { reason: err instanceof Error ? err.name : 'unknown' },
      'headless exporter module failed to load; export will initialize on first use',
    )
  }
}

/**
 * The daemon process: it listens on its owner-only socket and nowhere else
 * (ADR-0050), writes the record every client reads that socket from, and
 * removes it again when it stops.
 */
export async function main() {
  applyLoadedConfigFileForServerEntrypoint()

  const token = resolveToken(process.argv, process.env)
  const idleTimeoutMs = parseInt(
    readArg('idle-timeout-ms', `${15 * 60_000}`) ?? `${15 * 60_000}`,
    10,
  )

  checkStartupConfig()

  const version = process.env.npm_package_version ?? PACKAGE_VERSION
  // Only the discovery metadata travels from here. The strategy that checks
  // the credential is built inside `createApp`, over the one resolver.
  const mcpProtectedResourceMetadata = resolveMcpProtectedResourceMetadataFromEnv(process.env)

  // Initialise OpenTelemetry before any HTTP / store wiring so the very
  // first request on a freshly started daemon already carries a span. The
  // SDK is a no-op unless WHITEBOARD_OTEL=1 or OTEL_EXPORTER_OTLP_ENDPOINT
  // is set, so this costs nothing in the default path.
  const { initTracing } = await import('./observability/tracing.js')
  await initTracing({ role: 'daemon' })

  // Block startup until the schema is migrated so route handlers never see
  // a half-initialized data directory.
  const { prepareDataDir } = await import('./store/db/prepare.js')
  const dataDir = getDataDir()
  await prepareDataDir(dataDir)

  // Notice level (not info) because misdirected persistence — e.g. a dev
  // daemon accidentally writing into the real ~/.whiteboard — is expensive
  // to notice otherwise; this line is the one place that names where data
  // actually landed for this process.
  getLogger('server-index').notice(
    { dataDir, source: process.env.WHITEBOARD_DATA_DIR ? 'env' : 'default' },
    'resolved data dir',
  )

  await prewarmExporter()

  // Read once here, after the startup-issue gate above already validated it
  // — never re-read process.env inside a route.
  const replicaEnv = resolveReplicaEnv(process.env)

  const running = await startHttpServer({
    token,
    mcpProtectedResourceMetadata,
    idleTimeoutMs,
    replicaTier: replicaEnv.tier,
    replicaLeaseTtlMs: replicaEnv.leaseTtlMs,
    socketPath: daemonSocketPath(dataDir),
    onClose: async () => {
      await deleteDaemonRecord(dataDir)
    },
  })

  if (token) {
    // Pass the resolved `dataDir` explicitly rather than relying on
    // saveDaemonRecord's default parameter (the frozen DATA_DIR const) — the
    // default would silently diverge from where this process actually
    // prepared/serves data whenever getDataDir() has been redirected (tests,
    // and any future dev entrypoint that redirects the seam).
    await saveDaemonRecord(
      {
        pid: process.pid,
        token,
        version,
        startedAt: running.getRuntimeStatus().startedAt,
        socketPath: running.socketPath,
      },
      dataDir,
    )
  }

  const shutdown = () => {
    void running.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdout.write('READY\n')
}
