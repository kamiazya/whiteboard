#!/usr/bin/env node
// Shared helpers for distribution smoke scripts: leak detection, plus the one
// Docker build invocation both server-mode smokes have to get identical.
// Process lifecycle and temp-dir creation remain in each script.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
 * leak in — ensureDaemon and the mcp-http child spawner both branch on this
 * flag to run `node --watch --import tsx/esm <root>/src/...`, which fails
 * against an installed-only tree that ships no `src/` and no `tsx`
 * devDependency (see tarball.distribution-impl.ts buildTarballSmokeChildEnv
 * for the TypeScript-side twin of this same fix).
 *
 * @param {NodeJS.ProcessEnv} processEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function scrubDevEnv(processEnv) {
  const { WHITEBOARD_DEV: _unused, ...rest } = processEnv
  return rest
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
