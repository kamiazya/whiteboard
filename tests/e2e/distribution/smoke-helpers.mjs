#!/usr/bin/env node
// Shared helpers for distribution smoke scripts: leak detection, failure
// reporting, the ES256 JWT and TLS fixtures the server-mode smokes build their
// mock identity provider from, container and CLI runners, and the one Docker
// build invocation both Docker smokes have to get identical. What stays in
// each script is the scenario list and the values only that script owns.
//
// A function declared in two scripts is a failing guard
// (`distribution-smoke-helpers-one-place.test.ts`), so a script binds a
// helper to its own label or entry point with a `create*` factory rather than
// re-declaring it.

import { spawnSync } from 'node:child_process'
import { sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Core security leak patterns: auth headers, JWTs, local filesystem paths,
 * TypeScript stack frames. All distribution smoke scripts check against this set.
 */
export const BASE_LEAK_PATTERNS = [
  /Authorization/i,
  /Bearer/i,
  // Raw JWT (three base64url segments) — must not appear in server output.
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/,
  /\/opt\//,
  /\/home\//,
  /\/root\//,
  /\/Users\//,
  /\/private\//,
  // Canonical /tmp/ literal (regex form matches "/tmp/" but not "notmp/foo")
  /(^|[^a-zA-Z])\/tmp\//,
  // TypeScript source-map line references — indicate a raw stack frame leaked
  /\.ts:\d/,
]

/**
 * Canvas plaintext deny-list. Used by scripts that exercise log/support-bundle
 * formatting where canvas content must be stripped before output.
 */
export const CANVAS_LEAK_PATTERNS = [/canvasText/, /rawPayload/, /"scene"/, /"elements"/, /"files"/]

/**
 * Assert that `text` does not match any BASE_LEAK_PATTERNS entry and does not
 * include any `extraLiterals` string. Throws on the first match so the calling
 * script exits non-zero (the throw propagates through any surrounding
 * try/finally cleanup block before the process terminates).
 *
 * @param {string} label - Surface identifier printed in the failure message.
 * @param {string} text - Content to inspect.
 * @param {string[]} [extraLiterals=[]] - Additional literal strings to deny
 *   (checked with String.prototype.includes, not regex).
 */
export function assertNoLeak(label, text, extraLiterals = []) {
  for (const re of BASE_LEAK_PATTERNS) {
    if (re.test(text)) throw new Error(`[smoke] ${label} leak: ${re}`)
  }
  for (const literal of extraLiterals) {
    if (text.includes(literal)) throw new Error(`[smoke] ${label} leak: literal "${literal}"`)
  }
}

/**
 * Strips WHITEBOARD_DEV from an env object before it is spread into a
 * spawned child. Every distribution smoke here exercises the packaged
 * `dist/` build, never the `src/` tree, so an ambient WHITEBOARD_DEV=1 (the
 * publish-gate CI job sets it for its other src-mode e2e checks) must never
 * leak in — the server branches on this flag to resolve its own tree under
 * `src/` with `tsx`, which fails against an installed-only tree that ships
 * no `src/` and no `tsx` devDependency (see tarball.distribution-impl.ts
 * buildTarballSmokeChildEnv for the TypeScript-side twin of this same fix).
 *
 * @param {NodeJS.ProcessEnv} processEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function scrubDevEnv(processEnv) {
  const { WHITEBOARD_DEV: _unused, ...rest } = processEnv
  return rest
}

/**
 * A failing smoke's captured output, safe to print.
 *
 * The smokes deliberately report byte COUNTS rather than text, because their
 * last scenario asserts that no JWT, Authorization header or absolute dataDir
 * path reaches a log. That discipline is right and it makes a CI-only failure
 * undiagnosable: `stderrBytes: 62` says something went wrong and nothing about
 * what. This redacts through the SAME BASE_LEAK_PATTERNS the assertion uses,
 * so the two cannot disagree about what counts as a secret.
 *
 * @param {string} text
 * @param {string[]} extraLiterals values to blank out verbatim (temp dirs, tokens)
 * @returns {string}
 */
export function redactForDiagnostics(text, extraLiterals = []) {
  let out = text
  for (const pattern of BASE_LEAK_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    out = out.replace(new RegExp(pattern.source, flags), '[redacted]')
  }
  for (const literal of extraLiterals) {
    if (literal) out = out.split(literal).join('[redacted]')
  }
  return out
}
/**
 * `docker build` arguments for Dockerfile.server, `.node-version` included.
 *
 * Dockerfile.server declares `ARG NODE_VERSION` with no default, so a build
 * that omits it resolves `FROM node:${NODE_VERSION}-alpine` to `node:-alpine`
 * and fails on an invalid reference. Every call site therefore has to pass it,
 * and every call site that forgot did so silently: the two Docker smokes only
 * run on the release path, where the failure surfaces for the first time
 * during a publish.
 *
 * Not exported: `resolveServerImage` below is the entry point, so a caller
 * cannot reach the build without also getting the reuse path.
 *
 * @param {string} repoRoot
 * @param {string} imageTag
 * @returns {string[]} argv for `docker`, starting at `build`
 */
function serverImageBuildArgv(repoRoot, imageTag) {
  const nodeVersion = readFileSync(join(repoRoot, '.node-version'), 'utf-8').trim()
  return [
    'build',
    '--build-arg',
    `NODE_VERSION=${nodeVersion}`,
    '-f',
    join(repoRoot, 'Dockerfile.server'),
    '-t',
    imageTag,
    repoRoot,
  ]
}

/**
 * The image a Docker smoke should exercise: an already-built one when
 * WHITEBOARD_SMOKE_IMAGE names it, otherwise a fresh build.
 *
 * Building the server image is the single most expensive thing this repo's
 * verification does, and it was being done up to three times per commit — once
 * in CI's dry-run, once by each smoke, once more for the published artifact.
 * The env var lets a caller that has ALREADY built (with a layer cache CI can
 * keep, which a plain `docker build` in a fresh runner cannot) hand the tag
 * over instead.
 *
 * A named image that is not present is a hard failure, never a quiet rebuild:
 * a fallback here would turn "one build per commit" back into two while every
 * log still said it worked.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.defaultTag tag to build into when nothing is reused
 * @param {(args: string[], opts?: object) => { status: number | null }} options.docker
 * @param {(message: string) => never} options.fail
 * @param {string} options.label log prefix, e.g. 'docker-smoke'
 * @returns {string} the image tag to run
 */
export function resolveServerImage({ repoRoot, defaultTag, docker, fail, label }) {
  const reused = process.env.WHITEBOARD_SMOKE_IMAGE
  if (reused) {
    const present = docker(['image', 'inspect', reused], { timeout: 30_000 })
    if (present.status !== 0) {
      fail(`WHITEBOARD_SMOKE_IMAGE names "${reused}", which is not present locally`)
    }
    console.log(`[${label}] reusing prebuilt image ${reused}; skipping build`)
    return reused
  }
  console.log(`[${label}] Building image (may take several minutes)…`)
  const built = docker(serverImageBuildArgv(repoRoot, defaultTag), {
    timeout: 600_000,
    stdio: 'inherit',
  })
  if (built.status !== 0) fail('docker build failed')
  return defaultTag
}

/**
 * A `fail(message, context)` that prints `[label] FAIL: message`, one indented
 * line per context entry that has a value, and exits 1.
 *
 * Context values are printed, so a caller that must not leak (every smoke's
 * last scenario asserts that) passes lengths or redacted text, never the raw
 * output.
 *
 * @param {string} label
 * @returns {(message: string, context?: Record<string, unknown>) => never}
 */
export function createFail(label) {
  return (message, context = {}) => {
    console.error(`[${label}] FAIL: ${message}`)
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== '') {
        console.error(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      }
    }
    process.exit(1)
  }
}

/**
 * A `skip(reason)` that prints `[label] SKIP: reason` and exits 0.
 *
 * @param {string} label
 * @returns {(reason: string) => never}
 */
export function createSkip(label) {
  return (reason) => {
    console.log(`[${label}] SKIP: ${reason}`)
    process.exit(0)
  }
}

/**
 * Temp directories a script creates and removes together at the end.
 *
 * @returns {{ make: (prefix: string) => string, cleanup: () => void }}
 */
export function createTempDirs() {
  const made = []
  return {
    make(prefix) {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      made.push(dir)
      return dir
    },
    cleanup() {
      for (const dir of made) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Runs the packaged CLI under `cliEntry` with WHITEBOARD_DEV scrubbed from the
 * child environment, and throws if the process could not be spawned.
 *
 * `defaults` are `spawnSync` options a script applies to every call; a call's
 * own `options` win, except `env`, which is merged over the scrubbed ambient
 * one. A `timeout` has to leave headroom over the longest wait the command
 * itself performs (`server stop` waits up to 10s for its child before it
 * escalates), or the CLI timeout races the production-side one.
 *
 * @param {string} cliEntry absolute path to `dist/cli/index.js`
 * @param {import('node:child_process').SpawnSyncOptions} [defaults]
 * @returns {(args: string[], options?: import('node:child_process').SpawnSyncOptions) => import('node:child_process').SpawnSyncReturns<string>}
 */
export function createCliRunner(cliEntry, defaults = {}) {
  return (args, options = {}) => {
    const result = spawnSync(process.execPath, [cliEntry, ...args], {
      encoding: 'utf8',
      ...defaults,
      ...options,
      env: { ...scrubDevEnv(process.env), ...defaults.env, ...options.env },
    })
    if (result.error) throw new Error(`CLI spawn failed: ${String(result.error)}`)
    return result
  }
}

/**
 * One stdout line as a server's READY record (`{ ok: true, pid }`), or
 * `undefined`.
 *
 * The stream carries ordinary log lines too, so a line that is not JSON, or is
 * JSON saying something else, is simply not the record a smoke is waiting for.
 *
 * @param {string} line
 */
export function readyRecord(line) {
  if (!line.trim()) return undefined
  try {
    const obj = JSON.parse(line)
    return obj.ok === true && typeof obj.pid === 'number' ? obj : undefined
  } catch {
    return undefined
  }
}

/** `docker <args>` with UTF-8 output and a 120s default timeout. */
export function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000, ...opts })
}

export function stopContainer(name) {
  docker(['stop', '-t', '10', name], { timeout: 20_000 })
}

/**
 * Polls a container's logs for its READY record.
 *
 * Answers the record, or `null` on timeout. When the container stops before
 * emitting one the answer is `null` too, unless `reportExit` is set, in which
 * case it is `{ _stopped: true, stdout, stderr }` carrying the logs read at
 * that moment: a stopped container's logs are still there, but a caller that
 * wants them in a failure message has to take them before it removes the
 * container.
 *
 * @param {string} containerName
 * @param {{ timeoutMs?: number, reportExit?: boolean }} [options]
 */
export async function waitForContainerReadyJson(
  containerName,
  { timeoutMs = 60_000, reportExit = false } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await delay(1000)
    const logs = docker(['logs', containerName], { timeout: 5_000 })
    const ready = logs.stdout
      .split('\n')
      .map(readyRecord)
      .find((r) => r !== undefined)
    if (ready !== undefined) return ready
    const inspect = docker(['inspect', '--format={{.State.Running}}', containerName], {
      timeout: 5_000,
    })
    if (inspect.stdout.trim() !== 'true') {
      if (!reportExit) return null
      const exitLogs = docker(['logs', containerName], { timeout: 5_000 })
      return { _stopped: true, stdout: exitLogs.stdout, stderr: exitLogs.stderr }
    }
  }
  return null
}

/**
 * Polls `url` until it answers 2xx, and says whether it did within the budget.
 *
 * A container emits its ready record before Docker's host-side port mapping is
 * necessarily up, so the first request may arrive too early; `intervalMs` is
 * the pause between tries.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitForHttpReady(url, { timeoutMs = 15_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      /* port not yet reachable */
    }
    await delay(intervalMs)
  }
  return false
}

export function base64url(data) {
  return Buffer.from(data).toString('base64url')
}

/**
 * An ES256 JWT (RFC 7518 section 3.4) signed with `privateKey`.
 *
 * `ieee-p1363` makes Node return the raw 64-byte r||s a JWT carries, rather
 * than the ASN.1 DER a default signature has, so nothing here parses DER.
 *
 * @param {import('node:crypto').KeyObject} privateKey
 * @param {object} header
 * @param {object} payload
 */
export function signEs256Jwt(privateKey, header, payload) {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = sign('SHA256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${base64url(signature)}`
}

/**
 * A `mint(privateKey, scope)` for the one-hour access token a smoke presents
 * to a server whose JWKS it hosts. The key id, subject and client are named
 * after `name` so a token in a log says which smoke minted it.
 *
 * @param {{ name: string, issuer: string, audience: string }} identity
 * @returns {(privateKey: import('node:crypto').KeyObject, scope: string) => string}
 */
export function createAccessTokenMinter({ name, issuer, audience }) {
  return (privateKey, scope) => {
    const now = Math.floor(Date.now() / 1000)
    return signEs256Jwt(
      privateKey,
      { alg: 'ES256', typ: 'at+jwt', kid: `${name}-key` },
      {
        sub: `${name}-user`,
        azp: `${name}-client`,
        scope,
        iss: issuer,
        aud: audience,
        iat: now,
        exp: now + 3600,
      },
    )
  }
}

/**
 * A self-signed CA certificate for the HTTPS JWKS mock, written to `dir` as
 * `server.key` / `server.crt`.
 *
 * It is handed to the spawned server through NODE_EXTRA_CA_CERTS, which
 * Node's fetch honours, so the server under test reaches the mock without TLS
 * verification being disabled anywhere. `subjectAltName` has to name the host
 * the server dials: a container reaching the host through
 * `host.docker.internal` needs that DNS name beside the loopback IP.
 *
 * @param {string} dir
 * @param {{ commonName: string, subjectAltName?: string }} options
 * @returns {{ keyFile: string, certFile: string }}
 */
export function generateTestTlsCert(dir, { commonName, subjectAltName = 'IP:127.0.0.1' }) {
  const keyFile = join(dir, 'server.key')
  const certFile = join(dir, 'server.crt')
  const cnfFile = join(dir, 'openssl.cnf')
  writeFileSync(
    cnfFile,
    [
      '[req]',
      'distinguished_name = req_dn',
      'x509_extensions = san_ext',
      'prompt = no',
      '[req_dn]',
      `CN = ${commonName}`,
      '[san_ext]',
      `subjectAltName = ${subjectAltName}`,
      'basicConstraints = critical,CA:true',
    ].join('\n'),
  )
  const r = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-nodes',
      '-config',
      cnfFile,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`openssl cert gen failed: ${r.stderr}`)
  return { keyFile, certFile }
}
