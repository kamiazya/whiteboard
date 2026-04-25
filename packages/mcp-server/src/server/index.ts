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

export { createApp } from './app.js'
export { startHttpServer } from './http-server.js'

async function main() {
  const port = parseInt(readArg('port', '3099') ?? '3099', 10)
  const host = readArg('host', '127.0.0.1') ?? '127.0.0.1'
  const token = readArg('token')
  const idleTimeoutMs = parseInt(readArg('idle-timeout-ms', `${15 * 60_000}`) ?? `${15 * 60_000}`, 10)
  const daemonMode = hasFlag('daemon')
  const version = process.env.npm_package_version ?? PACKAGE_VERSION
  const mcpAuth = createLocalTokenMcpHttpAuthStrategy({
    token,
    protectedResourceMetadata: resolveMcpProtectedResourceMetadataFromEnv(process.env),
  })

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
