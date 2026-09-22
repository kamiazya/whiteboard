// @whiteboard/checks — release-gate-matrix.json shared validator.
//
// tools/checks deliberately stays dependency-free: it is the last mile before a
// real `npm publish` / `docker push`, so it must not depend on this repo's own
// build/install pipeline (Zod, TypeScript compilation, workspace resolution) to
// even validate its own policy file. Plain object/array checks are enough for a
// small hand-authored JSON file.
//
// This module is the SINGLE authority for what a valid release-gate-matrix.json
// looks like. Both the runtime consumers (publish-gate.mjs, pages-release.mjs)
// and the test suite (release-gate-matrix.test.ts, gate-isomorphism.test.ts)
// import validateGate/validateMatrix from here instead of each re-implementing
// or hand-rolling their own shape check — a second, drifted validator is exactly
// how a schema-vs-runtime mismatch ships unnoticed.

/** @typedef {{ ok: true } | { ok: false, reason: string }} ValidationResult */

const KNOWN_PR_COVERAGE_KINDS = new Set([
  'workflow-step',
  'conditional-workflow-step',
  'aggregate',
  'exception',
])

// Single authority for the closed vocabularies a gate's category,
// expectedRuntimeBucket, and requiredFor tiers may use. Runtime validation
// only checked "is a non-empty string" before, so a typo'd tier (e.g.
// "publsih") passed validateMatrix while publish-gate.mjs's exact-string
// `.includes('publish')` filter silently excluded that gate from the publish
// tier — a fail-open outcome behind a check whose whole purpose is fail-loud.
export const KNOWN_REQUIRED_FOR_TIERS = new Set([
  'ci',
  'local-release',
  'docker-release',
  'publish',
  'pages-release',
  'publish-dry-run',
])
export const KNOWN_CATEGORIES = new Set([
  'unit',
  'typecheck',
  'build',
  'release-artifacts',
  'tarball',
  'mcp-protocol',
  'codex-config',
  'distribution',
  'docker',
  'mutation',
  'publish',
  'pages',
])
export const KNOWN_RUNTIME_BUCKETS = new Set(['fast', 'medium', 'slow'])

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The string fields each `prCoverage` kind must carry, in the order they are
 * checked.
 *
 * A conditional step is exercised on SOME pull requests. Its two extra fields
 * exist so that stays a stated policy rather than a silent weakening of
 * workflow-step: `condition` is checked against the step's real `if:` (a
 * drifted copy fails), and `conditionReason` is the argument for why the pull
 * requests it skips cannot change the gate's answer — the only part a reader
 * cannot derive from the workflow.
 *
 * `isNonEmptyString` trims: a blank field names nothing, whichever it is.
 * @type {Record<string, readonly string[]>}
 */
const REQUIRED_BY_KIND = {
  'workflow-step': ['workflow', 'jobId', 'stepName'],
  'conditional-workflow-step': ['workflow', 'jobId', 'stepName', 'condition', 'conditionReason'],
  aggregate: ['workflow', 'jobId'],
  exception: ['reason'],
}

/**
 * @param {unknown} substrings
 * @returns {string | undefined}
 */
function expectedSubstringsProblem(substrings) {
  if (!Array.isArray(substrings) || substrings.length === 0) {
    return 'prCoverage.expectedCommandSubstrings must be a non-empty array when present'
  }
  if (substrings.some((entry) => !isNonEmptyString(entry))) {
    return 'prCoverage.expectedCommandSubstrings entries must be non-empty strings'
  }
  return undefined
}

/**
 * Validate the optional per-gate `prCoverage` declaration: where this gate's
 * command is exercised on a pull request, so a machine check can confirm the
 * release-only gate isn't actually release-only.
 * @param {unknown} prCoverage
 * @returns {ValidationResult}
 */
export function validatePrCoverage(prCoverage) {
  if (typeof prCoverage !== 'object' || prCoverage === null) {
    return { ok: false, reason: 'prCoverage must be an object' }
  }
  const p = /** @type {Record<string, unknown>} */ (prCoverage)
  if (typeof p.kind !== 'string' || !KNOWN_PR_COVERAGE_KINDS.has(p.kind)) {
    return {
      ok: false,
      reason: `prCoverage.kind must be one of ${[...KNOWN_PR_COVERAGE_KINDS].join(', ')}`,
    }
  }
  const missing = REQUIRED_BY_KIND[p.kind].find((field) => !isNonEmptyString(p[field]))
  if (missing !== undefined) {
    return { ok: false, reason: `prCoverage.${missing} must be a non-empty string` }
  }
  if (p.kind === 'aggregate' && 'expectedCommandSubstrings' in p) {
    const reason = expectedSubstringsProblem(p.expectedCommandSubstrings)
    if (reason !== undefined) return { ok: false, reason }
  }
  return { ok: true }
}

/**
 * @param {string} field
 * @returns {(g: Record<string, unknown>) => string | undefined}
 */
const nonEmptyString = (field) => (g) =>
  isNonEmptyString(g[field]) ? undefined : `${field} must be a non-empty string`

/**
 * @param {string} field
 * @param {Set<unknown>} known
 * @returns {(g: Record<string, unknown>) => string | undefined}
 */
const oneOf = (field, known) => (g) =>
  known.has(g[field])
    ? undefined
    : `${field} must be one of ${[...known].join(', ')}, got "${g[field]}"`

/**
 * @param {string} field
 * @returns {(g: Record<string, unknown>) => string | undefined}
 */
const boolean = (field) => (g) =>
  typeof g[field] === 'boolean' ? undefined : `${field} must be boolean`

/** @param {Record<string, unknown>} g */
function requiredForProblem(g) {
  if (!Array.isArray(g.requiredFor) || g.requiredFor.length === 0) {
    return 'requiredFor must be a non-empty array'
  }
  if (g.requiredFor.some((t) => typeof t !== 'string')) {
    return 'requiredFor entries must be strings'
  }
  const unknownTier = g.requiredFor.find((t) => !KNOWN_REQUIRED_FOR_TIERS.has(t))
  return unknownTier === undefined
    ? undefined
    : `requiredFor must be one of ${[...KNOWN_REQUIRED_FOR_TIERS].join(', ')}, got "${unknownTier}"`
}

// Docker-required gates must never appear in non-Docker aggregates.
// ci and local-release scripts run without Docker; mixing Docker gates
// in would silently skip them on non-Docker runners.
//
// The `publish-dry-run` tier is deliberately NOT on that list. Its runner is
// `pnpm publish:dry-run`, whose Docker half exits 0 with a skip line when no
// daemon answers — the same fail-soft the ci/local-release aggregates must
// not have, and correct here because the tier's job is to rehearse a publish,
// not to gate one. That distinction is the tier's whole reason to exist:
// before it, the two `publish:dry-run:*` jobs ran on every PR while being
// declared in no tier at all, so nothing tied their ci.yml steps to a policy
// file and `smoke:docker`'s prCoverage exception could cite a job the matrix
// had never heard of.
/** @param {Record<string, unknown>} g */
function dockerTierProblem(g) {
  if (g.requiresDocker !== true) return undefined
  const tiers = /** @type {string[]} */ (g.requiredFor)
  const tier = ['ci', 'local-release'].find((t) => tiers.includes(t))
  return tier === undefined ? undefined : `Docker-required gate must not be required for ${tier}`
}

/** @param {Record<string, unknown>} g */
function prCoverageProblem(g) {
  if (!('prCoverage' in g) || g.prCoverage === undefined) return undefined
  const result = validatePrCoverage(g.prCoverage)
  return result.ok ? undefined : `prCoverage: ${result.reason}`
}

/**
 * A gate's rules, in the order they are checked; the first that answers is
 * the gate's reason.
 *
 * No runner honors a per-gate `env` map (publish-gate.mjs and
 * pages-release.mjs only read id/command/requiredFor), so it is
 * deliberately NOT schema-validated here — validating a field nothing
 * consumes would look load-bearing but silently do nothing. Any shape
 * under `env` is tolerated as an additive unknown field.
 */
const GATE_RULES = [
  nonEmptyString('id'),
  nonEmptyString('command'),
  nonEmptyString('category'),
  oneOf('category', KNOWN_CATEGORIES),
  requiredForProblem,
  boolean('requiresDocker'),
  boolean('requiresNetwork'),
  nonEmptyString('expectedRuntimeBucket'),
  oneOf('expectedRuntimeBucket', KNOWN_RUNTIME_BUCKETS),
  dockerTierProblem,
  prCoverageProblem,
]

/**
 * Validate a single release-gate-matrix.json gate entry.
 * @param {unknown} gate
 * @returns {ValidationResult}
 */
export function validateGate(gate) {
  if (typeof gate !== 'object' || gate === null) {
    return { ok: false, reason: 'gate must be an object' }
  }
  const g = /** @type {Record<string, unknown>} */ (gate)
  for (const rule of GATE_RULES) {
    const reason = rule(g)
    if (reason !== undefined) return { ok: false, reason }
  }
  return { ok: true }
}

/**
 * Validate a whole release-gate-matrix.json document: schemaVersion, the gates
 * array shape, and every individual gate.
 * @param {unknown} matrix
 * @returns {ValidationResult}
 */
export function validateMatrix(matrix) {
  if (typeof matrix !== 'object' || matrix === null) {
    return { ok: false, reason: 'matrix must be an object' }
  }
  const m = /** @type {Record<string, unknown>} */ (matrix)
  if (m.schemaVersion !== 1) {
    return { ok: false, reason: 'schemaVersion must be 1' }
  }
  if (!Array.isArray(m.gates) || m.gates.length === 0) {
    return { ok: false, reason: 'gates must be a non-empty array' }
  }
  const ids = new Set()
  for (const gate of /** @type {unknown[]} */ (m.gates)) {
    const result = validateGate(gate)
    if (!result.ok) {
      const id = typeof gate === 'object' && gate !== null ? gate.id : undefined
      return { ok: false, reason: `gate "${id}": ${result.reason}` }
    }
    const gid = /** @type {{ id: string }} */ (gate).id
    if (ids.has(gid)) {
      return { ok: false, reason: `duplicate gate id "${gid}"` }
    }
    ids.add(gid)
  }
  return { ok: true }
}
