#!/usr/bin/env node
import { deleteDaemonRecord, saveDaemonRecord } from '../daemon/daemon-registry.js'
import { startHttpServer } from './http-server.js'
import { DATA_DIR } from './config.js'
import {
  createLocalTokenMcpHttpAuthStrategy,
  resolveMcpProtectedResourceMetadataFromEnv,
} from './security/mcp-auth.js'
import { isDirectEntryPoint } from './entrypoint.js'
import { loadAllowedWebOriginsFromEnv } from './security/web-origin-allowlist.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { applyConfigFileToEnv, loadConfigFile } from './config-file.js'
import { getLogger, parseLogLevel, setLogLevel } from './log.js'

function readArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/**
 * Resolves the bearer token from CLI args then env.
 * --token=<value> takes precedence so packaged scripts that bake in a
 * default value work predictably; WHITEBOARD_TOKEN lets all three
 * processes (daemon, Vite plugin, ensure-daemon probe) stay in sync
 * from a single shell export.
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
function applyLoadedConfigFileForServerEntrypoint(): number | undefined {
  const loaded = loadConfigFile()
  if (loaded === null) return undefined

  const envLogLevelWasUnset = process.env.WHITEBOARD_LOG_LEVEL === undefined
  applyConfigFileToEnv(loaded.config, process.env)
  const log = getLogger('server-index')
  log.info({ filepath: loaded.filepath }, 'loaded whiteboard config file')

  if (envLogLevelWasUnset && loaded.config.logLevel !== undefined) {
    const level = parseLogLevel(loaded.config.logLevel)
    if (level !== null) setLogLevel(level)
  }

  if (loaded.config.dataDir !== undefined) {
    log.warning(
      { filepath: loaded.filepath },
      'config file dataDir is not honored on this entrypoint; set WHITEBOARD_DATA_DIR instead',
    )
  }

  return loaded.config.port
}

export async function main() {
  const configFilePort = applyLoadedConfigFileForServerEntrypoint()

  const port = parseInt(readArg('port') ?? String(configFilePort ?? 3099), 10)
  const host = readArg('host', '127.0.0.1') ?? '127.0.0.1'
  const token = resolveToken(process.argv, process.env)
  const idleTimeoutMs = parseInt(
    readArg('idle-timeout-ms', `${15 * 60_000}`) ?? `${15 * 60_000}`,
    10,
  )

  // Fail fast, before any tracing/store/server wiring: an invalid
  // WHITEBOARD_ALLOWED_WEB_ORIGINS must abort startup rather than silently
  // fall back to an empty (loopback-only) allowlist. The failure record is
  // logged by loadAllowedWebOriginsFromEnv itself (no raw value echoed).
  const allowedWebOrigins = loadAllowedWebOriginsFromEnv(process.env)
  if (allowedWebOrigins === null) {
    process.exit(1)
  }

  // A hosted origin in the allowlist widens which browser origins may reach
  // /api CORS, /mcp, and WS upgrade. Without a Bearer token, missing-token
  // auth strategies treat every request as authenticated (local-dev
  // convenience), so pairing that fallback with a hosted origin would let an
  // allowlisted hosted page mutate the daemon with no auth barrier at all.
  // Refuse to start rather than silently downgrade the allowlist's promise
  // that it "does not change authentication".
  if (allowedWebOrigins.length > 0 && !token) {
    const log = getLogger('server-index')
    log.error(
      { allowedOriginCount: allowedWebOrigins.length },
      'WHITEBOARD_ALLOWED_WEB_ORIGINS is set but no auth token was provided (--token or WHITEBOARD_TOKEN); refusing to start',
    )
    process.exit(1)
  }

  const daemonMode = hasFlag('daemon')
  const version = process.env.npm_package_version ?? PACKAGE_VERSION
  const mcpAuth = createLocalTokenMcpHttpAuthStrategy({
    token,
    protectedResourceMetadata: resolveMcpProtectedResourceMetadataFromEnv(process.env),
  })

  // Initialise OpenTelemetry before any HTTP / store wiring so the very
  // first request on a freshly started daemon already carries a span. The
  // SDK is a no-op unless WHITEBOARD_OTEL=1 or OTEL_EXPORTER_OTLP_ENDPOINT
  // is set, so this costs nothing in the default path.
  const { initTracing } = await import('./observability/tracing.js')
  await initTracing({ role: daemonMode ? 'daemon' : 'http' })

  // Block startup until the schema is migrated and the v0 importer has run
  // so route handlers never see a half-initialized data directory.
  const { prepareDataDir } = await import('./store/db/prepare.js')
  await prepareDataDir(DATA_DIR)

  // Best-effort: warm the headless renderer in the background so the first
  // export_png call (when no browser is connected) does not pay the
  // jsdom + canvas + resvg + woff2 startup cost. Errors are logged inside.
  if (daemonMode) {
    const { prewarmHeadlessExporter } = await import('./export/headless-renderer.js')
    void prewarmHeadlessExporter()
  }

  const running = await startHttpServer({
    port,
    host,
    token,
    mcpAuth,
    idleTimeoutMs,
    allowedWebOrigins,
    onClose: daemonMode
      ? async () => {
          await deleteDaemonRecord(DATA_DIR)
        }
      : undefined,
  })

  if (daemonMode && token) {
    await saveDaemonRecord({
      pid: process.pid,
      port: running.port,
      token,
      version,
      startedAt: running.getRuntimeStatus().startedAt,
    })
  }

  const shutdown = () => {
    void running.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdout.write('READY\n')
}

const isEntryPoint = isDirectEntryPoint(import.meta.url)
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`HTTP server error: ${err}\n`)
    process.exit(1)
  })
}
