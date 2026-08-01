import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { buildSbomSidecar } from '../../../scripts/release/sbom-fingerprint.mjs'
import { evaluateSbomArtifactState, SBOM_REGENERATE_COMMAND } from './sbom-artifact-state.js'

const EXPECTED_INPUTS = {
  'pnpm-lock.yaml': 'a'.repeat(64),
  'packages/mcp-server/package.json': 'b'.repeat(64),
}
const SBOM_SHA512 = 'c'.repeat(128)

function currentSidecarText(): string {
  const sidecar = buildSbomSidecar(EXPECTED_INPUTS, Buffer.from('sbom-bytes'))
  // Force the sbomSha512 in the fixture to match the actualSbomSha512 used by
  // the tests below without depending on buildSbomSidecar's own hash of an
  // arbitrary fixture buffer.
  return JSON.stringify({ ...sidecar, sbomSha512: SBOM_SHA512 })
}

describe('evaluateSbomArtifactState', () => {
  it('reports absent when the SBOM artifact itself does not exist', () => {
    const result = evaluateSbomArtifactState({
      sbomExists: false,
      rawSidecarText: undefined,
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: SBOM_SHA512,
    })
    expect(result.status).toBe('absent')
  })

  it('reports current when the sidecar fingerprint matches the current inputs and SBOM bytes', () => {
    const result = evaluateSbomArtifactState({
      sbomExists: true,
      rawSidecarText: currentSidecarText(),
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: SBOM_SHA512,
    })
    expect(result.status).toBe('current')
  })

  // RED 1 (regression pin): a stale artifact — its persisted input fingerprint
  // no longer matches the current lockfile/manifest digests — must be
  // reported as 'stale' with an actionable, distinguishing message, NOT
  // surfaced as a dependency-policy violation.
  it('reports stale (not current) when the persisted input fingerprint no longer matches', () => {
    const staleSidecar = JSON.stringify({
      schemaVersion: 1,
      algorithm: 'SHA-256',
      inputs: { ...EXPECTED_INPUTS, 'pnpm-lock.yaml': 'f'.repeat(64) },
      sbomSha512: SBOM_SHA512,
    })

    const result = evaluateSbomArtifactState({
      sbomExists: true,
      rawSidecarText: staleSidecar,
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: SBOM_SHA512,
    })

    expect(result.status).toBe('stale')
    if (result.status !== 'stale') throw new Error('unreachable')
    expect(result.message).toContain(SBOM_REGENERATE_COMMAND)
    expect(result.message.toLowerCase()).toContain('stale')
    expect(result.message).not.toMatch(/policy|dev-only|removed package/i)
  })

  it('reports stale when the SBOM file bytes no longer match the recorded checksum', () => {
    const result = evaluateSbomArtifactState({
      sbomExists: true,
      rawSidecarText: currentSidecarText(),
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: 'd'.repeat(128),
    })
    expect(result.status).toBe('stale')
  })

  it('reports stale when the sidecar file is missing', () => {
    const result = evaluateSbomArtifactState({
      sbomExists: true,
      rawSidecarText: undefined,
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: SBOM_SHA512,
    })
    expect(result.status).toBe('stale')
    if (result.status !== 'stale') throw new Error('unreachable')
    expect(result.reason).toContain('missing')
  })

  it('reports stale when the sidecar is not valid JSON', () => {
    const result = evaluateSbomArtifactState({
      sbomExists: true,
      rawSidecarText: '{ not json',
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: SBOM_SHA512,
    })
    expect(result.status).toBe('stale')
    if (result.status !== 'stale') throw new Error('unreachable')
    expect(result.reason).toContain('not valid JSON')
  })

  it('reports stale when the sidecar JSON fails schema validation', () => {
    const result = evaluateSbomArtifactState({
      sbomExists: true,
      rawSidecarText: JSON.stringify({
        schemaVersion: 2,
        algorithm: 'SHA-256',
        inputs: {},
        sbomSha512: '',
      }),
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: SBOM_SHA512,
    })
    expect(result.status).toBe('stale')
    if (result.status !== 'stale') throw new Error('unreachable')
    expect(result.reason).toContain('schema')
  })

  it('reports stale when the input file set differs (added/removed input)', () => {
    const result = evaluateSbomArtifactState({
      sbomExists: true,
      rawSidecarText: JSON.stringify({
        schemaVersion: 1,
        algorithm: 'SHA-256',
        inputs: { 'pnpm-lock.yaml': 'a'.repeat(64) },
        sbomSha512: SBOM_SHA512,
      }),
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: SBOM_SHA512,
    })
    expect(result.status).toBe('stale')
  })

  it('the stale message contains no absolute-path prefix and no .ts:<line> frame', () => {
    const result = evaluateSbomArtifactState({
      sbomExists: true,
      rawSidecarText: undefined,
      expectedInputs: EXPECTED_INPUTS,
      actualSbomSha512: SBOM_SHA512,
    })
    expect(result.status).toBe('stale')
    if (result.status !== 'stale') throw new Error('unreachable')
    for (const forbidden of ['/home/', '/Users/', '/opt/', '/root/', '/private/', '/tmp/']) {
      expect(result.message).not.toContain(forbidden)
    }
    expect(result.message).not.toMatch(/\.ts:\d/)
  })

  // PBT: totality over arbitrary JSON-ish raw sidecar text. The evaluator
  // must never throw regardless of shape, and always resolve to exactly one
  // of absent | stale | current.
  const arbitraryJson = fc.anything({ withBigInt: false, withDate: false })

  fcTest.prop([arbitraryJson.map((v) => JSON.stringify(v) ?? 'undefined')], withDefaults())(
    'is total over arbitrary sidecar JSON text and never throws',
    (rawSidecarText) => {
      const result = evaluateSbomArtifactState({
        sbomExists: true,
        rawSidecarText,
        expectedInputs: EXPECTED_INPUTS,
        actualSbomSha512: SBOM_SHA512,
      })
      expect(['absent', 'stale', 'current']).toContain(result.status)
    },
  )
})
