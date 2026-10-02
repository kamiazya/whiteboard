// `whiteboard server run --json` business logic.
//
// Merges CLI flags on top of env vars, validates with parseServerModeEnvConfig
// + planServerModeAuth, then either emits a dry-run summary or starts the
// server. The JWKS key resolver and JWT validator are wired here; callers
// inject `startServer` for tests (the production default is startServerModeHttp).
//
// Non-leak contract: failure results never contain raw env var values, URLs,
// credentials, hostnames, or tokens — only codes and field names reach callers.

import { resolve } from 'node:path'
import type { z } from 'zod'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { getLogger } from '../server/log.js'
import { createJwksKeyResolver } from '../server/security/jwks-resolver.js'
import type { AuthenticatorBinding } from '../server/security/member-profile-store.js'
import { createOAuthJwtValidator } from '../server/security/oauth-jwt-validator.js'
import type { AsyncAuthStrategy } from '../server/security/oauth-resource-strategy.js'
import { createOAuthResourceServerAuthStrategy } from '../server/security/oauth-resource-strategy.js'
import type { ConfiguredProvider } from '../server/security/oidc-relying-party.js'
import { planServerModeAuth } from '../server/security/server-mode-auth-plan.js'
import {
  parseServerModeEnvConfig,
  type ServerModeEnvConfigResult,
} from '../server/security/server-mode-env-config.js'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import {
  deleteServerModeRecord,
  SERVER_MODE_RECORD_SCHEMA_VERSION,
  writeServerModeRecord,
} from '../server/security/server-mode-record.js'
import { loadSignInConfig, SIGN_IN_CONFIG_ENV } from '../server/security/sign-in-config-file.js'
import { collectStartupEnvIssues } from '../server/startup-env.js'
import {
  OPERATOR_JSON_SCHEMA_VERSION,
  type serverRunDryRunOutputSchema,
  type serverRunReadyOutputSchema,
} from './operator-json.js'
import { mergeCliFlagsIntoEnv, type ServerRunArgs } from './server-run-args.js'

type ServerRunDryRunResult = z.infer<typeof serverRunDryRunOutputSchema>
type ServerRunReadyResult = z.infer<typeof serverRunReadyOutputSchema>

interface StartServerOptions {
  host: string
  port: number
  publicBaseUrl: string
  allowedOrigins: readonly string[]
  authStrategy: AsyncAuthStrategy
  signInProviders?: readonly ConfiguredProvider[]
  configuredAdministrators?: readonly AuthenticatorBinding[]
}

const log = getLogger('server-run')

function signInConfigFrom(env: NodeJS.ProcessEnv): ReturnType<typeof loadSignInConfig> | null {
  const path = env[SIGN_IN_CONFIG_ENV]
  if (path === undefined || path === '') return { providers: [], administrators: [] }
  try {
    return loadSignInConfig(path, env)
  } catch (err) {
    // The loader's message names the setting at fault, never a secret value.
    log.error({ err }, 'the sign-in configuration cannot be used')
    return null
  }
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

// The bearer path MCP clients and API callers use: an access token from the
// one configured issuer, validated against its JWKS.
function bearerAuthStrategy(
  config: Extract<ServerModeEnvConfigResult, { ok: true }>['config'],
): AsyncAuthStrategy {
  const validator = createOAuthJwtValidator({
    issuer: config.jwtIssuer,
    audience: [...config.jwtAudience],
    clockSkewSeconds: config.jwtClockSkewSeconds,
    scopeClaim: config.jwtScopeClaim,
    allowUntypedAccessTokens: config.jwtAllowUntypedAccessTokens,
    keyResolver: createJwksKeyResolver(config.jwksUri),
  })
  return createOAuthResourceServerAuthStrategy({ validator })
}

export async function runServerRun(options: RunServerRunOptions): Promise<ServerRunOutcome> {
  const env = mergeCliFlagsIntoEnv(options.env ?? process.env, options.flags)
  const writeFn = options.writeRecord ?? writeServerModeRecord
  const deleteFn = options.deleteRecord ?? deleteServerModeRecord

  const parsed = parseServerModeEnvConfig(env)
  if (!parsed.ok) {
    return { kind: 'config-error', code: parsed.code, field: parsed.field }
  }

  // A setting the operator configured and this process cannot honour stops
  // the server, rather than starting it on a default nobody asked for.
  // Same posture the daemon already takes for a malformed allowed-origins
  // list: a silent fallback looks identical to never having configured it.
  // The first issue is reported as the field, and the rest ride along in the
  // code, so one restart teaches the operator about every bad variable.
  const startupIssues = collectStartupEnvIssues(
    resolve(parsed.config.dataDir ?? resolveDefaultDataDir(env)),
    env,
  )
  const firstIssue = startupIssues[0]
  if (firstIssue !== undefined) {
    return {
      kind: 'config-error',
      code: `startup_env.${startupIssues.map((issue) => issue.variable).join(',')}`,
      field: firstIssue.variable,
    }
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

  const signIn = signInConfigFrom(env)
  if (signIn === null) {
    return { kind: 'config-error', code: 'sign_in_config.invalid', field: SIGN_IN_CONFIG_ENV }
  }

  if (options.flags.dryRun) {
    return {
      kind: 'dry-run-ok',
      result: {
        schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
        ok: true,
        dryRun: true,
        publicBaseUrl: plan.publicBaseUrl,
        allowedOrigins: [...plan.allowedOrigins],
        authStrategy: parsed.config.authStrategy,
      },
    }
  }

  // Set WHITEBOARD_DATA_DIR so config.js (loaded transitively by
  // server-mode-http.ts) picks up the right data directory.
  if (parsed.config.dataDir !== undefined) {
    process.env.WHITEBOARD_DATA_DIR = parsed.config.dataDir
  }

  const authStrategy = bearerAuthStrategy(parsed.config)

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
      signInProviders: signIn.providers,
      configuredAdministrators: signIn.administrators,
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
      schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
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
