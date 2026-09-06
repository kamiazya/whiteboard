// Hand an inline `docker buildx` step the credentials the `type=gha` cache
// backend falls back to.
//
// The runner provides these to JavaScript actions and not to `run:` steps, so
// a workflow that shells out to buildx gets a cache that is configured, runs,
// and stores nothing — measured here as 0/15 layers across four builds, ~200s
// recompiled every time, with no warning from buildx and no cache step in its
// progress output at all. Docker's own documentation for the backend says an
// inline invocation must expose them manually.
//
// Local rather than the third-party action those docs suggest, for one
// measured reason: that action's implementation is
// `core.info(`${key}=${process.env[key]}`)` over every ACTIONS_* variable,
// with no setSecret and no add-mask anywhere in its source — checked at its
// v4.0.0 tag and on its default branch. This repository is public, and so are
// its job logs.

// ESM, because the repository root declares `"type": "module"` and this file
// inherits it. The runner executes this path with node directly, so the
// declaration is what decides — and `node --check` does not: it parses, and
// CommonJS is what it parses as. Its first CI run died on `require is not
// defined in ES module scope` with every unit case green, which is why the
// test file now also runs this file in a real subprocess.
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Exactly what the backend documents as its fallbacks — `url`
// ($ACTIONS_CACHE_URL or $ACTIONS_RESULTS_URL), `url_v2`, `token` and the
// `version` switch — and exactly what the build's own cache report names, so a
// variable this list misses is reported absent rather than missed in silence.
const CACHE_ENV = [
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_CACHE_URL',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_CACHE_SERVICE_V2',
]

// Only the token. The URLs are not credentials, and masking them would replace
// every occurrence in the job log with *** for no gain.
const SECRET = new Set(['ACTIONS_RUNTIME_TOKEN'])

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ present: string[], absent: string[], secret: string[] }}
 */
export function planExposure(env) {
  const present = CACHE_ENV.filter((name) => (env[name] ?? '') !== '')
  return {
    present,
    absent: CACHE_ENV.filter((name) => !present.includes(name)),
    secret: present.filter((name) => SECRET.has(name)),
  }
}

/**
 * The runner's delimited form. `KEY=value` is forgeable by any value carrying
 * a newline; this is not, and costs two lines.
 *
 * @param {{ present: string[] }} plan
 * @param {Record<string, string | undefined>} env
 * @param {string} delimiter
 */
export function envFileLines(plan, env, delimiter) {
  const lines = []
  for (const name of plan.present) {
    const value = String(env[name])
    if (value.includes(delimiter)) {
      throw new Error(`${name} contains the generated delimiter; refusing to write GITHUB_ENV`)
    }
    lines.push(`${name}<<${delimiter}`, value, delimiter)
  }
  return lines
}

/**
 * Masking is the runner reading the value once, on stdout, and replacing it
 * everywhere after. It has to be emitted before anything else can print it.
 *
 * @param {{ secret: string[] }} plan
 * @param {Record<string, string | undefined>} env
 */
export function maskCommands(plan, env) {
  return plan.secret.map((name) => `::add-mask::${env[name]}`)
}

/**
 * What a reader sees. Names and counts; never a value.
 *
 * @param {{ present: string[], absent: string[] }} plan
 */
export function announce(plan) {
  const lines = [`exposed to later steps: ${plan.present.join(', ') || '(none)'}`]
  if (plan.absent.length > 0) {
    lines.push(`not provided by the runner: ${plan.absent.join(', ')}`)
  }
  return lines
}

function run() {
  const plan = planExposure(process.env)
  for (const command of maskCommands(plan, process.env)) {
    process.stdout.write(`${command}\n`)
  }
  const envFile = process.env.GITHUB_ENV
  if (envFile && plan.present.length > 0) {
    const lines = envFileLines(plan, process.env, `ghenv_${randomUUID()}`)
    appendFileSync(envFile, `${lines.join('\n')}\n`)
  }
  for (const line of announce(plan)) {
    process.stdout.write(`${line}\n`)
  }
}

// Run only when the runner invoked this file, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run()
