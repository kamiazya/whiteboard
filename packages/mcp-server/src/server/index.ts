#!/usr/bin/env node
import { deleteDaemonRecord, saveDaemonRecord } from '../daemon/daemon-registry.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { getDataDir } from './config.js'
import { applyConfigFileToEnvAndLogLevel, loadConfigFile } from './config-file.js'
import { isDirectEntryPoint } from './entrypoint.js'
import { startHttpServer } from './http-server.js'
import { getLogger } from './log.js'
import {
  createLocalTokenMcpHttpAuthStrategy,
  resolveMcpProtectedResourceMetadataFromEnv,
} from './security/mcp-auth.js'
import { parseOAuthClientRegistryEnv } from './security/oauth-authz-registry.js'
import { loadAllowedWebOriginsFromEnv } from './security/web-origin-allowlist.js'

/**
 * Reads a `--name=value` flag out of an argv list. When the same flag is
 * passed more than once, `Array.prototype.find` returns the FIRST match —
 * this is a load-bearing detail for `mcp:http:dev`, which relies on its
 * caller-provided `--port` winning over any port this process's own
 * wrapper might append later in the argv list.
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
//
// loadConfigFile throws on a malformed file (by design). Catch it here and
// fail the same way the WHITEBOARD_ALLOWED_WEB_ORIGINS gate below does
// (structured getLogger record + process.exit(1)) instead of letting the
// throw propagate to the generic top-level `main().catch` at the bottom of
// this file, which would echo the raw error/stack on stderr unredacted.
function applyLoadedConfigFileForServerEntrypoint(): number | undefined {
  let loaded: ReturnType<typeof loadConfigFile>
  try {
    loaded = loadConfigFile()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    getLogger('server-index').error(
      { message },
      'invalid whiteboard config file; refusing to start',
    )
    process.exit(1)
  }
  if (loaded === null) return undefined

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

  // Same fail-fast posture: a malformed registry must abort startup rather
  // than leave the authorization-server surface silently unmounted, which
  // would look identical to "the operator never configured it".
  const oauthRegistry = parseOAuthClientRegistryEnv(process.env.WHITEBOARD_OAUTH_CLIENT_REGISTRY)
  if (!oauthRegistry.ok) {
    const log = getLogger('server-index')
    log.error(
      { reason: oauthRegistry.error },
      'WHITEBOARD_OAUTH_CLIENT_REGISTRY could not be parsed; refusing to start',
    )
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

  // Best-effort: warm the headless renderer in the background so the first
  // export_canvas call does not pay the font-parse + resvg-import startup
  // cost. Errors are logged inside; the catch below is the last-resort net.
  if (daemonMode) {
    const { prewarmHeadlessExporter } = await import('./export/headless-renderer.js')
    prewarmHeadlessExporter().catch((err) => {
      getLogger('server-index').warning(
        { err: err instanceof Error ? err : new Error(String(err)) },
        'headless exporter pre-warm failed',
      )
    })
  }

  const running = await startHttpServer({
    port,
    host,
    token,
    mcpAuth,
    idleTimeoutMs,
    allowedWebOrigins,
    oauthClientRegistry: oauthRegistry.registry,
    onClose: daemonMode
      ? async () => {
          await deleteDaemonRecord(dataDir)
        }
      : undefined,
  })

  if (daemonMode && token) {
    // Pass the resolved `dataDir` explicitly rather than relying on
    // saveDaemonRecord's default parameter (the frozen DATA_DIR const) — the
    // default would silently diverge from where this process actually
    // prepared/serves data whenever getDataDir() has been redirected (tests,
    // and any future dev entrypoint that redirects the seam).
    await saveDaemonRecord(
      {
        pid: process.pid,
        port: running.port,
        token,
        version,
        startedAt: running.getRuntimeStatus().startedAt,
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

const isEntryPoint = isDirectEntryPoint(import.meta.url)
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`HTTP server error: ${err}\n`)
    process.exit(1)
  })
}
