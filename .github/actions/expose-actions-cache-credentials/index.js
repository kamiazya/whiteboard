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

const { appendFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')

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
function planExposure(env) {
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
function envFileLines(plan, env, delimiter) {
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
function maskCommands(plan, env) {
  return plan.secret.map((name) => `::add-mask::${env[name]}`)
}

/**
 * What a reader sees. Names and counts; never a value.
 *
 * @param {{ present: string[], absent: string[] }} plan
 */
function announce(plan) {
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

if (require.main === module) run()

exports.planExposure = planExposure
exports.envFileLines = envFileLines
exports.maskCommands = maskCommands
exports.announce = announce
