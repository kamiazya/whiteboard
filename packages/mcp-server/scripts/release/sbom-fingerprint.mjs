// Shared hashing + sidecar-builder for the generated-SBOM staleness contract.
//
// One implementation used by both the writer (generate-npm-sbom.mjs) and the
// reader (sbom-artifact-state.ts / sbom-policy.test.ts) so the two can never
// diverge on how the fingerprint is computed.
//
// Input set: pnpm-lock.yaml (resolution source of truth for every prod and
// workspace dependency) and packages/mcp-server/package.json (declares this
// package's own dependency list, which pnpm-lock.yaml alone does not tie to
// a specific package). Both are hashed, never re-derived by walking
// node_modules — that would make the fingerprint itself as slow as the SBOM
// generation this sidecar exists to avoid re-running on every pre-push.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Repo-relative paths whose contents determine SBOM currency. */
export const SBOM_FINGERPRINT_INPUT_PATHS = ['pnpm-lock.yaml', 'packages/mcp-server/package.json']

/**
 * @param {Buffer | string} bytes
 * @returns {string} lowercase hex SHA-256 digest
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param {Buffer | string} bytes
 * @returns {string} lowercase hex SHA-512 digest
 */
export function sha512Hex(bytes) {
  return createHash('sha512').update(bytes).digest('hex')
}

/**
 * Computes a SHA-256 digest for each declared input path, keyed by its
 * repo-relative path.
 *
 * @param {string} workspaceRoot absolute path to the repo root
 * @returns {Record<string, string>}
 */
export function computeSbomInputFingerprint(workspaceRoot) {
  /** @type {Record<string, string>} */
  const inputs = {}
  for (const relPath of SBOM_FINGERPRINT_INPUT_PATHS) {
    const bytes = readFileSync(join(workspaceRoot, relPath))
    inputs[relPath] = sha256Hex(bytes)
  }
  return inputs
}

/**
 * Builds the sidecar JSON object persisted alongside the generated SBOM.
 *
 * @param {Record<string, string>} inputs result of computeSbomInputFingerprint
 * @param {Buffer} sbomBytes the SBOM file's raw bytes
 * @returns {{schemaVersion: 1, algorithm: 'SHA-256', inputs: Record<string, string>, sbomSha512: string}}
 */
export function buildSbomSidecar(inputs, sbomBytes) {
  return {
    schemaVersion: 1,
    algorithm: 'SHA-256',
    inputs,
    sbomSha512: sha512Hex(sbomBytes),
  }
}
