// `whiteboard daemon run --json` business logic.
//
// Starts the HTTP server in-process, writes the daemon record, emits the ready
// JSON, and installs SIGTERM/SIGINT handlers that close the server and remove
// the record before exiting. The dispatcher keeps the process alive with its
// own never-resolving promise after calling this function.

import { createServer } from 'node:net'
import { nanoid } from 'nanoid'
import { withDaemonStartupLock } from '../daemon/daemon-lock.js'
import {
  deleteDaemonRecord,
  isPidAlive,
  loadDaemonRecord,
  saveDaemonRecord,
} from '../daemon/daemon-registry.js'
import { DATA_DIR } from '../shared/data-dir-secure.js'
import { assertLoopbackBindHost } from '../server/daemon-auth-binding.js'
import { startHttpServer } from '../server/http-server.js'
import { parseOAuthClientRegistryEnv } from '../server/security/oauth-authz-registry.js'
import { loadAllowedWebOriginsFromEnv } from '../server/security/web-origin-allowlist.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'

const DAEMON_RUN_SCHEMA_VERSION = 1 as const

export interface DaemonRunReadyResult {
  readonly schemaVersion: typeof DAEMON_RUN_SCHEMA_VERSION
  readonly ok: true
  readonly pid: number
  readonly port: number
  readonly host: string
  readonly version: string
  readonly startedAt: string
}

export type DaemonRunOutcome =
  | {
      kind: 'input-error'
      message: string
      code?:
        | 'invalid_allowed_web_origins'
        | 'invalid_oauth_client_registry'
        | 'token_source_conflict'
    }
  | { kind: 'refused'; message: string }
  | { kind: 'running'; result: DaemonRunReadyResult }

export interface DaemonRunOptions {
  host?: string
  port?: number
  dataDir?: string
  tokenStdin: boolean
  /** Defaults to process.env; overridable for tests. */
  env?: Readonly<Record<string, string | undefined>>
}

// Exported for unit testing of the EADDRINUSE-only retry contract.
export async function findAvailablePort(start = 3099): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(start, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : start
      server.close(() => resolve(port))
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      // Only retry the next port when this one is in use. Any other error (EACCES,
      // EADDRNOTAVAIL, …) is permanent for this scan and must reject immediately
      // instead of walking ~62k ports and hiding the real cause behind a generic message.
      if (error.code !== 'EADDRINUSE') {
        reject(error)
        return
      }
      if (start >= 65535) {
        reject(new Error('No available TCP port found'))
        return
      }
      findAvailablePort(start + 1).then(resolve, reject)
    })
  })
}

async function readTokenFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
    })
    process.stdin.on('end', () => resolve(buf.trim()))
    process.stdin.on('error', reject)
  })
}

function installDaemonSignalHandlers(cleanup: () => Promise<void>): void {
  const handle = () => {
    void cleanup().finally(() => process.exit(0))
  }
  process.once('SIGTERM', handle)
  process.once('SIGINT', handle)
}

export async function runDaemonRun(options: DaemonRunOptions): Promise<DaemonRunOutcome> {
  const dataDir = options.dataDir ?? DATA_DIR
  const host = options.host ?? '127.0.0.1'

  // Pre-startup guard: local-daemon is loopback-only regardless of --host.
  // Refusing here (before any lock/fs work) means a non-loopback bind never
  // reaches startHttpServer, so an unauthenticated daemon can't be exposed
  // beyond loopback even by operator error.
  const bindGuard = assertLoopbackBindHost(host)
  if (!bindGuard.ok) {
    return {
      kind: 'refused',
      message:
        'Refusing to bind the local daemon to a non-loopback host. Use 127.0.0.1, localhost, or ::1.',
    }
  }

  // Fail fast before any lock/fs work: an invalid WHITEBOARD_ALLOWED_WEB_ORIGINS
  // must never start a daemon with a silently-empty or partially-parsed
  // allowlist. loadAllowedWebOriginsFromEnv logs the structured failure via
  // getLogger without echoing the raw offending value.
  const allowedWebOrigins = loadAllowedWebOriginsFromEnv(options.env ?? process.env)
  if (allowedWebOrigins === null) {
    return {
      kind: 'input-error',
      message: 'Invalid WHITEBOARD_ALLOWED_WEB_ORIGINS entry. See the daemon log for details.',
      code: 'invalid_allowed_web_origins',
    }
  }

  // Same fail-fast posture as the allowlist above: a malformed registry must
  // not start a daemon whose authorization-server surface is silently absent.
  const oauthRegistry = parseOAuthClientRegistryEnv(
    (options.env ?? process.env).WHITEBOARD_OAUTH_CLIENT_REGISTRY,
  )
  if (!oauthRegistry.ok) {
    return {
      kind: 'input-error',
      message: `Invalid WHITEBOARD_OAUTH_CLIENT_REGISTRY (${oauthRegistry.error}).`,
      code: 'invalid_oauth_client_registry',
    }
  }

  // Fail fast on ambiguous token input: honouring one source silently would
  // let an operator's script think stdin (or the env var) took effect when
  // the other one actually did. Checked by presence only — never touches
  // either token's value, so nothing can leak into this message.
  if (options.tokenStdin && (options.env ?? process.env).WHITEBOARD_DAEMON_TOKEN !== undefined) {
    return {
      kind: 'input-error',
      message:
        'Conflicting token sources: --token-stdin and WHITEBOARD_DAEMON_TOKEN cannot both be set. Choose one.',
      code: 'token_source_conflict',
    }
  }

  const existing = await loadDaemonRecord(dataDir)
  if (existing !== null && isPidAlive(existing.pid)) {
    return {
      kind: 'refused',
      message: 'A daemon is already running. Stop it first with: whiteboard daemon stop --json',
    }
  }

  let token: string
  if (options.tokenStdin) {
    try {
      token = await readTokenFromStdin()
    } catch {
      return { kind: 'input-error', message: 'Failed to read token from stdin.' }
    }
    if (!token) {
      return { kind: 'input-error', message: 'Token read from stdin was empty.' }
    }
  } else {
    // Read through options.env (defaulting to process.env) rather than
    // process.env directly so config-file-layered values (applied by the
    // dispatcher before this is called) and test overrides share one seam
    // with the allowedWebOrigins read above.
    token = (options.env ?? process.env).WHITEBOARD_DAEMON_TOKEN ?? nanoid(32)
  }

  return await withDaemonStartupLock(dataDir, async () => {
    const port = options.port ?? (await findAvailablePort())

    const running = await startHttpServer({
      port,
      host,
      token,
      allowedWebOrigins,
      oauthClientRegistry: oauthRegistry.registry,
    })

    const startedAt = new Date().toISOString()

    await saveDaemonRecord(
      {
        pid: process.pid,
        port: running.port,
        token,
        version: PACKAGE_VERSION,
        startedAt,
      },
      dataDir,
    )

    installDaemonSignalHandlers(async () => {
      await running.close()
      await deleteDaemonRecord(dataDir)
    })

    return {
      kind: 'running' as const,
      result: {
        schemaVersion: DAEMON_RUN_SCHEMA_VERSION,
        ok: true,
        pid: process.pid,
        port: running.port,
        host,
        version: PACKAGE_VERSION,
        startedAt,
      },
    }
  })
}
