#!/usr/bin/env node
import { deleteDaemonRecord, saveDaemonRecord } from '../daemon/daemon-registry.js'
import { startHttpServer } from './http-server.js'
import { DATA_DIR } from './config.js'
import {
  createLocalTokenMcpHttpAuthStrategy,
  resolveMcpProtectedResourceMetadataFromEnv,
} from './security/mcp-auth.js'
import { isDirectEntryPoint } from './entrypoint.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'

function readArg(name: string, fallback?: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
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
  return argv.find((arg) => arg.startsWith('--token='))?.split('=')[1] ?? env.WHITEBOARD_TOKEN
}

export { createApp } from './app.js'
export { startHttpServer } from './http-server.js'

async function main() {
  const port = parseInt(readArg('port', '3099') ?? '3099', 10)
  const host = readArg('host', '127.0.0.1') ?? '127.0.0.1'
  const token = resolveToken(process.argv, process.env)
  const idleTimeoutMs = parseInt(
    readArg('idle-timeout-ms', `${15 * 60_000}`) ?? `${15 * 60_000}`,
    10,
  )
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
