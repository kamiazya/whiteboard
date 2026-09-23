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
import { purgeLegacyWebOriginTrustFile } from '../daemon/purge-legacy-trust-file.js'
import { assertLoopbackBindHost } from '../server/daemon-auth-binding.js'
import { startHttpServer } from '../server/http-server.js'
import { getLogger } from '../server/log.js'
import { resolveReplicaEnv } from '../server/replica-env.js'
import { parseOAuthClientRegistryEnv } from '../server/security/oauth-authz-registry.js'
import { loadAllowedWebOriginsFromEnv } from '../server/security/web-origin-allowlist.js'
import { collectStartupEnvIssues } from '../server/startup-env.js'
import {
  type DaemonRunReadyResult,
  daemonRunReadyResultSchema,
} from '../shared/api-contracts/daemon-run.js'
import { getDataDir, overrideDataDir } from '../shared/data-dir-secure.js'
import { describeEnvIssues } from '../shared/env-setting.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'

export type DaemonRunOutcome =
  | {
      kind: 'input-error'
      message: string
      code?:
        | 'invalid_allowed_web_origins'
        | 'invalid_oauth_client_registry'
        | 'token_source_conflict'
        | 'startup_env'
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

/**
 * Best-effort, on every startup: the stale silent-reconnect credential file
 * holds enrolled public keys and hashed legacy secrets for a feature that no
 * longer has a server half, and its outcome must never decide whether the
 * daemon starts. `purgeLegacyWebOriginTrustFile` already swallows its own
 * expected failures (ENOENT, permission errors); this catch is
 * defense-in-depth against any other rejection reaching the caller.
 */
async function purgeLegacyTrustFile(dataDir: string): Promise<void> {
  try {
    await purgeLegacyWebOriginTrustFile(dataDir)
  } catch (err) {
    getLogger('daemon-startup').warning(
      { err: err as Error },
      'legacy reconnect trust-file purge failed unexpectedly',
    )
  }
}

/** A refusal an operator can fix by changing one setting. */
function configError(
  message: string,
  code: Extract<DaemonRunOutcome, { kind: 'input-error' }>['code'],
): { outcome: DaemonRunOutcome } {
  return { outcome: { kind: 'input-error', message, code } }
}

/**
 * The two VALUES an operator's environment supplies, or the refusal that
 * says one of them could not be understood. Fail-fast for the same reason in
 * both cases: a daemon that starts with a silently-empty allowlist, or with
 * its authorization surface absent, is worse than one that does not start.
 * `loadAllowedWebOriginsFromEnv` logs the structured failure via `getLogger`
 * without echoing the raw offending value.
 */
function resolveEnvConfig(env: NodeJS.ProcessEnv):
  | {
      allowedWebOrigins: NonNullable<ReturnType<typeof loadAllowedWebOriginsFromEnv>>
      oauthClientRegistry: Extract<
        ReturnType<typeof parseOAuthClientRegistryEnv>,
        { ok: true }
      >['registry']
    }
  | { outcome: DaemonRunOutcome } {
  const allowedWebOrigins = loadAllowedWebOriginsFromEnv(env)
  if (allowedWebOrigins === null) {
    return configError(
      'Invalid WHITEBOARD_ALLOWED_WEB_ORIGINS entry. See the daemon log for details.',
      'invalid_allowed_web_origins',
    )
  }

  const oauthRegistry = parseOAuthClientRegistryEnv(env.WHITEBOARD_OAUTH_CLIENT_REGISTRY)
  if (!oauthRegistry.ok) {
    return configError(
      `Invalid WHITEBOARD_OAUTH_CLIENT_REGISTRY (${oauthRegistry.error}).`,
      'invalid_oauth_client_registry',
    )
  }

  return { allowedWebOrigins, oauthClientRegistry: oauthRegistry.registry }
}

/**
 * The two refusals that produce no value of their own.
 *
 * The first covers every remaining setting an operator can configure
 * (WHITEBOARD_REPLICA_TIER, the storage family, WHITEBOARD_LOG_LEVEL — see
 * startup-env.ts). This is the packaged `whiteboard daemon run` command, a
 * separate startup path from server/index.ts's dev entrypoint, and must apply
 * the same gate or an invalid value is silently ignored rather than aborting.
 *
 * The second refuses two token sources at once: honouring one silently would
 * let an operator's script think stdin (or the env var) took effect when the
 * other one actually did. Checked by PRESENCE only, so no token's value is
 * ever read here and nothing can leak into the message.
 */
function startupEnvRefusal(
  env: NodeJS.ProcessEnv,
  options: DaemonRunOptions,
): { outcome: DaemonRunOutcome } | null {
  const startupIssues = collectStartupEnvIssues(getDataDir(), env)
  if (startupIssues.length > 0) {
    getLogger('daemon-startup').error(
      { issues: describeEnvIssues(startupIssues) },
      'configured settings could not be understood; refusing to start',
    )
    return configError(
      `Invalid configuration: ${startupIssues.map((issue) => issue.variable).join(', ')}. See the daemon log for details.`,
      'startup_env',
    )
  }

  if (options.tokenStdin && env.WHITEBOARD_DAEMON_TOKEN !== undefined) {
    return configError(
      'Conflicting token sources: --token-stdin and WHITEBOARD_DAEMON_TOKEN cannot both be set. Choose one.',
      'token_source_conflict',
    )
  }

  return null
}

/**
 * Every gate an operator's configuration has to pass BEFORE any lock or
 * filesystem work, and the two values that survive them.
 */
function resolveStartupConfig(
  host: string,
  options: DaemonRunOptions,
): ReturnType<typeof resolveEnvConfig> {
  // local-daemon is loopback-only regardless of --host. Refusing here means
  // a non-loopback bind never reaches startHttpServer, so an unauthenticated
  // daemon cannot be exposed beyond loopback even by operator error.
  if (!assertLoopbackBindHost(host).ok) {
    return {
      outcome: {
        kind: 'refused',
        message:
          'Refusing to bind the local daemon to a non-loopback host. Use 127.0.0.1, localhost, or ::1.',
      },
    }
  }

  const env = options.env ?? process.env
  const config = resolveEnvConfig(env)
  if ('outcome' in config) return config
  return startupEnvRefusal(env, options) ?? config
}

/**
 * The token this daemon will accept: read from stdin when asked for, else
 * taken from the environment, else minted. Read through `options.env` rather
 * than `process.env` directly so config-file-layered values (applied by the
 * dispatcher before this is called) and test overrides share one seam.
 */
async function resolveStartupToken(
  options: DaemonRunOptions,
): Promise<{ token: string } | { outcome: DaemonRunOutcome }> {
  if (!options.tokenStdin) {
    return { token: (options.env ?? process.env).WHITEBOARD_DAEMON_TOKEN ?? nanoid(32) }
  }
  let token: string
  try {
    token = await readTokenFromStdin()
  } catch {
    return { outcome: { kind: 'input-error', message: 'Failed to read token from stdin.' } }
  }
  if (!token) {
    return { outcome: { kind: 'input-error', message: 'Token read from stdin was empty.' } }
  }
  return { token }
}

export async function runDaemonRun(options: DaemonRunOptions): Promise<DaemonRunOutcome> {
  // An explicit --data-dir must govern ALL persistence (sqlite db, canvas
  // blobs, exports), not just the daemon registry file. Redirect the shared
  // data-dir seam before anything below touches disk so every store that
  // reads getDataDir() follows the requested directory.
  if (options.dataDir) {
    overrideDataDir(options.dataDir)
  }
  // Read back through the seam (not options.dataDir) so the registry and the
  // startup lock share the same resolved-absolute path the stores will use.
  const dataDir = getDataDir()

  await purgeLegacyTrustFile(dataDir)

  const host = options.host ?? '127.0.0.1'

  const config = resolveStartupConfig(host, options)
  if ('outcome' in config) return config.outcome

  const existing = await loadDaemonRecord(dataDir)
  if (existing !== null && isPidAlive(existing.pid)) {
    return {
      kind: 'refused',
      message: 'A daemon is already running. Stop it first with: whiteboard daemon stop --json',
    }
  }

  const resolved = await resolveStartupToken(options)
  if ('outcome' in resolved) return resolved.outcome
  const token = resolved.token

  return await withDaemonStartupLock(dataDir, async () => {
    const port = options.port ?? (await findAvailablePort())

    // Read once here, after the startup-issue gate above already validated
    // it — never re-read process.env inside a route.
    const replicaEnv = resolveReplicaEnv(options.env ?? process.env)

    const running = await startHttpServer({
      port,
      host,
      token,
      allowedWebOrigins: config.allowedWebOrigins,
      oauthClientRegistry: config.oauthClientRegistry,
      replicaTier: replicaEnv.tier,
      replicaLeaseTtlMs: replicaEnv.leaseTtlMs,
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
      result: daemonRunReadyResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        pid: process.pid,
        port: running.port,
        host,
        version: PACKAGE_VERSION,
        startedAt,
      }),
    }
  })
}
