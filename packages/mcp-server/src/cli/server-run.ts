// `whiteboard server run --json` business logic.
//
// Merges CLI flags on top of env vars, validates with parseServerModeEnvConfig
// + planServerModeAuth, then either emits a dry-run summary or starts the
// server. The JWKS key resolver and JWT validator are wired here; callers
// inject `startServer` for tests (the production default is startServerModeHttp).
//
// Non-leak contract: failure results never contain raw env var values, URLs,
// credentials, hostnames, or tokens — only codes and field names reach callers.

import { createOAuthJwtValidator } from '../server/security/oauth-jwt-validator.js'
import { createJwksKeyResolver } from '../server/security/jwks-resolver.js'
import { createOAuthResourceServerAuthStrategy } from '../server/security/oauth-resource-strategy.js'
import { planServerModeAuth } from '../server/security/server-mode-auth-plan.js'
import { ENV_KEYS, parseServerModeEnvConfig } from '../server/security/server-mode-env-config.js'
import {
  SERVER_MODE_RECORD_SCHEMA_VERSION,
  deleteServerModeRecord,
  writeServerModeRecord,
} from '../server/security/server-mode-record.js'
import type { AsyncAuthStrategy } from '../server/security/oauth-resource-strategy.js'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import type { ServerRunArgs } from './server-run-args.js'

const SERVER_RUN_SCHEMA_VERSION = 1 as const

interface ServerRunDryRunResult {
  readonly schemaVersion: typeof SERVER_RUN_SCHEMA_VERSION
  readonly ok: true
  readonly dryRun: true
  readonly publicBaseUrl: string
  readonly allowedOrigins: readonly string[]
  readonly authStrategy: 'oauth-jwt'
}

interface ServerRunReadyResult {
  readonly schemaVersion: typeof SERVER_RUN_SCHEMA_VERSION
  readonly ok: true
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly publicBaseUrl: string
  readonly authStrategy: 'oauth-jwt'
  readonly startedAt: string
}

interface StartServerOptions {
  host: string
  port: number
  publicBaseUrl: string
  allowedOrigins: readonly string[]
  authStrategy: AsyncAuthStrategy
}

interface ServerModeRunning {
  port: number
  host: string
  startedAt: string
  resolvedDataDir: string
  instanceId: string
  close: () => Promise<void>
}

export type StartServerFn = (opts: StartServerOptions) => Promise<ServerModeRunning>

export type ServerRunOutcome =
  | { kind: 'dry-run-ok'; result: ServerRunDryRunResult }
  | { kind: 'config-error'; code: string; field: string }
  | { kind: 'plan-error'; code: string }
  | { kind: 'running'; result: ServerRunReadyResult; close: () => Promise<void> }
  | { kind: 'start-error' }

export interface RunServerRunOptions {
  flags: ServerRunArgs & { kind: 'ok' }
  env?: NodeJS.ProcessEnv
  /** Injection seam: override the HTTP server factory for tests. */
  startServer?: StartServerFn
  /** Injection seam: override record writer for tests. */
  writeRecord?: (dataDir: string, record: ServerModeRecord) => void
  /** Injection seam: override record deleter for tests. */
  deleteRecord?: (dataDir: string) => void
}

function mergeCliFlagsIntoEnv(
  base: NodeJS.ProcessEnv,
  flags: ServerRunArgs & { kind: 'ok' },
): NodeJS.ProcessEnv {
  const env = { ...base }
  if (flags.externalUrl !== undefined) env[ENV_KEYS.EXTERNAL_URL] = flags.externalUrl
  if (flags.allowedOrigins !== undefined) env[ENV_KEYS.ALLOWED_ORIGINS] = flags.allowedOrigins
  if (flags.authStrategy !== undefined) env[ENV_KEYS.AUTH_STRATEGY] = flags.authStrategy
  if (flags.jwtIssuer !== undefined) env[ENV_KEYS.JWT_ISSUER] = flags.jwtIssuer
  if (flags.jwtAudience !== undefined) env[ENV_KEYS.JWT_AUDIENCE] = flags.jwtAudience
  if (flags.jwksUri !== undefined) env[ENV_KEYS.JWKS_URI] = flags.jwksUri
  if (flags.jwtClockSkew !== undefined) env[ENV_KEYS.JWT_CLOCK_SKEW_SECONDS] = flags.jwtClockSkew
  if (flags.jwtScopeClaim !== undefined) env[ENV_KEYS.JWT_SCOPE_CLAIM] = flags.jwtScopeClaim
  if (flags.host !== undefined) env[ENV_KEYS.HOST] = flags.host
  if (flags.port !== undefined) env[ENV_KEYS.PORT] = flags.port
  if (flags.dataDir !== undefined) env[ENV_KEYS.DATA_DIR] = flags.dataDir
  if (flags.trustedProxy === true) env[ENV_KEYS.TRUSTED_PROXY] = 'true'
  if (flags.trustedProxy === false) env[ENV_KEYS.TRUSTED_PROXY] = 'false'
  return env
}

export async function runServerRun(options: RunServerRunOptions): Promise<ServerRunOutcome> {
  const env = mergeCliFlagsIntoEnv(options.env ?? process.env, options.flags)
  const writeFn = options.writeRecord ?? writeServerModeRecord
  const deleteFn = options.deleteRecord ?? deleteServerModeRecord

  const parsed = parseServerModeEnvConfig(env)
  if (!parsed.ok) {
    return { kind: 'config-error', code: parsed.code, field: parsed.field }
  }

  const plan = planServerModeAuth({
    mode: 'server-mode',
    bindHost: parsed.config.host,
    externalUrl: parsed.config.externalUrl,
    allowedOrigins: [...parsed.config.allowedOrigins],
    trustedProxy: parsed.config.trustedProxy,
  })
  if (!plan.ok) {
    return { kind: 'plan-error', code: plan.code }
  }

  if (options.flags.dryRun) {
    return {
      kind: 'dry-run-ok',
      result: {
        schemaVersion: SERVER_RUN_SCHEMA_VERSION,
        ok: true,
        dryRun: true,
        publicBaseUrl: plan.publicBaseUrl,
        allowedOrigins: plan.allowedOrigins,
        authStrategy: parsed.config.authStrategy,
      },
    }
  }

  // Set WHITEBOARD_DATA_DIR so config.js (loaded transitively by
  // server-mode-http.ts) picks up the right data directory.
  if (parsed.config.dataDir !== undefined) {
    process.env.WHITEBOARD_DATA_DIR = parsed.config.dataDir
  }

  const keyResolver = createJwksKeyResolver(parsed.config.jwksUri)
  const validator = createOAuthJwtValidator({
    issuer: parsed.config.jwtIssuer,
    audience: [...parsed.config.jwtAudience],
    clockSkewSeconds: parsed.config.jwtClockSkewSeconds,
    scopeClaim: parsed.config.jwtScopeClaim,
    allowUntypedAccessTokens: parsed.config.jwtAllowUntypedAccessTokens,
    keyResolver,
  })
  const authStrategy = createOAuthResourceServerAuthStrategy({ validator })

  // Use the injected factory (tests) or the real HTTP server (production).
  // Dynamic import defers loading server/config.js (which has mkdirSync at
  // module load) until after WHITEBOARD_DATA_DIR is set above.
  const startFn: StartServerFn =
    options.startServer ?? (await import('../server/server-mode-http.js')).startServerModeHttp

  let running: ServerModeRunning
  try {
    running = await startFn({
      host: parsed.config.host,
      port: parsed.config.port,
      publicBaseUrl: plan.publicBaseUrl,
      allowedOrigins: [...plan.allowedOrigins],
      authStrategy,
    })
  } catch {
    // Startup failure (EADDRINUSE, permission, etc.). Discard the error
    // message — it may contain host, port, or filesystem paths.
    return { kind: 'start-error' }
  }

  const recordDir = running.resolvedDataDir
  try {
    writeFn(recordDir, {
      schemaVersion: SERVER_MODE_RECORD_SCHEMA_VERSION,
      pid: process.pid,
      host: running.host,
      port: running.port,
      publicBaseUrl: plan.publicBaseUrl,
      authStrategy: parsed.config.authStrategy,
      startedAt: running.startedAt,
      instanceId: running.instanceId,
    })
  } catch {
    // Record write failure means status/stop cannot locate this server.
    // Close the server so it doesn't run unmanaged, then report failure.
    try {
      await running.close()
    } catch {
      /* best-effort */
    }
    return { kind: 'start-error' }
  }

  const closeWithCleanup = async () => {
    await running.close()
    try {
      deleteFn(recordDir)
    } catch {
      /* best-effort */
    }
  }

  return {
    kind: 'running',
    result: {
      schemaVersion: SERVER_RUN_SCHEMA_VERSION,
      ok: true,
      pid: process.pid,
      host: running.host,
      port: running.port,
      publicBaseUrl: plan.publicBaseUrl,
      authStrategy: parsed.config.authStrategy,
      startedAt: running.startedAt,
    },
    close: closeWithCleanup,
  }
}
