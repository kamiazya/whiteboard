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

const KNOWN_PR_COVERAGE_KINDS = new Set(['workflow-step', 'aggregate', 'exception'])

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
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
  switch (p.kind) {
    case 'workflow-step':
    case 'aggregate': {
      if (!isNonEmptyString(p.workflow)) {
        return { ok: false, reason: 'prCoverage.workflow must be a non-empty string' }
      }
      if (!isNonEmptyString(p.jobId)) {
        return { ok: false, reason: 'prCoverage.jobId must be a non-empty string' }
      }
      if (p.kind === 'workflow-step' && !isNonEmptyString(p.stepName)) {
        return { ok: false, reason: 'prCoverage.stepName must be a non-empty string' }
      }
      break
    }
    case 'exception': {
      if (typeof p.reason !== 'string' || p.reason.trim().length === 0) {
        return { ok: false, reason: 'prCoverage.reason must be a non-empty string' }
      }
      break
    }
  }
  return { ok: true }
}

/**
 * Validate the optional per-gate `env` map: explicit environment variables the
 * runner passes to this gate's subprocess (the step-scoped-env hardening for
 * pillar C). Values must be strings — the same shape `process.env` requires.
 * @param {unknown} env
 * @returns {ValidationResult}
 */
export function validateGateEnv(env) {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    return { ok: false, reason: 'env must be a plain object' }
  }
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (env))) {
    if (typeof value !== 'string') {
      return { ok: false, reason: `env.${key} must be a string` }
    }
  }
  return { ok: true }
}

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
  if (!isNonEmptyString(g.id)) {
    return { ok: false, reason: 'id must be a non-empty string' }
  }
  if (!isNonEmptyString(g.command)) {
    return { ok: false, reason: 'command must be a non-empty string' }
  }
  if (!isNonEmptyString(g.category)) {
    return { ok: false, reason: 'category must be a non-empty string' }
  }
  if (!Array.isArray(g.requiredFor) || g.requiredFor.length === 0) {
    return { ok: false, reason: 'requiredFor must be a non-empty array' }
  }
  if (/** @type {unknown[]} */ (g.requiredFor).some((t) => typeof t !== 'string')) {
    return { ok: false, reason: 'requiredFor entries must be strings' }
  }
  if (typeof g.requiresDocker !== 'boolean') {
    return { ok: false, reason: 'requiresDocker must be boolean' }
  }
  if (typeof g.requiresNetwork !== 'boolean') {
    return { ok: false, reason: 'requiresNetwork must be boolean' }
  }
  if (!isNonEmptyString(g.expectedRuntimeBucket)) {
    return { ok: false, reason: 'expectedRuntimeBucket must be a non-empty string' }
  }
  // Docker-required gates must never appear in non-Docker aggregates.
  // ci and local-release scripts run without Docker; mixing Docker gates
  // in would silently skip them on non-Docker runners.
  if (g.requiresDocker === true) {
    const tiers = /** @type {string[]} */ (g.requiredFor)
    if (tiers.includes('ci')) {
      return { ok: false, reason: 'Docker-required gate must not be required for ci' }
    }
    if (tiers.includes('local-release')) {
      return { ok: false, reason: 'Docker-required gate must not be required for local-release' }
    }
  }
  if ('prCoverage' in g && g.prCoverage !== undefined) {
    const result = validatePrCoverage(g.prCoverage)
    if (!result.ok) return { ok: false, reason: `prCoverage: ${result.reason}` }
  }
  if ('env' in g && g.env !== undefined) {
    const result = validateGateEnv(g.env)
    if (!result.ok) return { ok: false, reason: `env: ${result.reason}` }
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
