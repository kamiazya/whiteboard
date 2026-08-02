// Distinguishes "generated SBOM artifact is stale" from "SBOM contains a real
// dependency-policy violation" — the two failure modes a bare existsSync
// guard could not tell apart (see sbom-policy.test.ts's content-regression
// describe block for the policy checks this gate protects).
//
// Pure and I/O-free by design: callers do all file reads and pass the raw
// results in, so this module is trivially total and trivially fast — the
// staleness check must never become a meaningful tax on the pre-push gate.

import { sbomFingerprintSidecarSchema } from './sbom-fingerprint-schema.js'

export const SBOM_ARTIFACT_REL_PATH = 'packages/mcp-server/_artifacts/npm-sbom.cdx.json'
export const SBOM_SIDECAR_REL_PATH = 'packages/mcp-server/_artifacts/npm-sbom.inputs.json'
export const SBOM_REGENERATE_COMMAND = 'pnpm --filter @kamiazya/whiteboard-mcp generate:sbom:npm'

export type SbomArtifactState =
  | { status: 'absent' }
  | { status: 'stale'; reason: string; message: string }
  | { status: 'current' }

function staleMessage(reason: string): string {
  return (
    `Stale SBOM artifact: ${SBOM_SIDECAR_REL_PATH} (${reason}). ` +
    `Run \`${SBOM_REGENERATE_COMMAND}\` to regenerate before re-running this check.`
  )
}

function stale(reason: string): SbomArtifactState {
  return { status: 'stale', reason, message: staleMessage(reason) }
}

/**
 * Evaluates whether a generated SBOM artifact is safe to run content-policy
 * assertions against.
 *
 * @param sbomExists whether the SBOM artifact file itself exists on disk
 * @param rawSidecarText the sidecar file's raw text content, or `undefined`
 *   if the sidecar file does not exist
 * @param expectedInputs the current SHA-256 fingerprint (from
 *   computeSbomInputFingerprint) to compare against the persisted one
 * @param actualSbomSha512 the SHA-512 of the SBOM file's current bytes
 */
export function evaluateSbomArtifactState(args: {
  sbomExists: boolean
  rawSidecarText: string | undefined
  expectedInputs: Record<string, string>
  actualSbomSha512: string
}): SbomArtifactState {
  const { sbomExists, rawSidecarText, expectedInputs, actualSbomSha512 } = args

  if (!sbomExists) {
    return { status: 'absent' }
  }

  if (rawSidecarText === undefined) {
    return stale('sidecar file is missing')
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawSidecarText)
  } catch {
    return stale('sidecar is not valid JSON')
  }

  const result = sbomFingerprintSidecarSchema.safeParse(parsedJson)
  if (!result.success) {
    return stale('sidecar failed schema validation')
  }

  const sidecar = result.data
  const expectedKeys = Object.keys(expectedInputs).sort()
  const actualKeys = Object.keys(sidecar.inputs).sort()
  const sameKeys =
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every((key, i) => key === actualKeys[i])
  if (!sameKeys) {
    return stale('input file set has changed since the SBOM was generated')
  }

  for (const key of expectedKeys) {
    if (sidecar.inputs[key] !== expectedInputs[key]) {
      return stale(`input fingerprint mismatch for ${key}`)
    }
  }

  if (sidecar.sbomSha512 !== actualSbomSha512) {
    return stale('SBOM file contents do not match the recorded checksum')
  }

  return { status: 'current' }
}
