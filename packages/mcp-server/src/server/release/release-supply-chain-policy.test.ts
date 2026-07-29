// Property catalog: supply-chain policy invariants.
// Drift guard: supply-chain-policy.json structure, MVP artifact classification,
// forbidden strategy absence, and cross-reference to the release gate matrix.
// PBT: validateArtifactPolicy() catches structural violations.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf-8'))
}

function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf-8')
}

interface ArtifactPolicy {
  id: string
  description: string
  mvp: boolean
  requiredMetadata: string[]
  signingStrategy: string
  implementedNow: boolean
  ciImplemented?: boolean
  ciJobId?: string
  ciWorkflow?: string
  futureGateId?: string
}

interface SupplyChainPolicy {
  schemaVersion: number
  releaseGateMatrixRef: string
  artifacts: ArtifactPolicy[]
  allowedSigningStrategies: string[]
  forbiddenSigningStrategies: string[]
}

type ValidationResult = { ok: true } | { ok: false; reason: string }

// Validates a single artifact entry against the policy constraints.
// Pure helper — exported so the PBT below can exercise it with arbitrary inputs.
export function validateArtifactPolicy(
  artifact: unknown,
  forbiddenStrategies: string[],
  allowedStrategies: string[],
): ValidationResult {
  if (typeof artifact !== 'object' || artifact === null) {
    return { ok: false, reason: 'must be an object' }
  }
  const a = artifact as Record<string, unknown>
  if (typeof a.id !== 'string' || a.id.length === 0) {
    return { ok: false, reason: 'id must be a non-empty string' }
  }
  if (typeof a.description !== 'string' || a.description.length === 0) {
    return { ok: false, reason: 'description must be a non-empty string' }
  }
  if (typeof a.mvp !== 'boolean') {
    return { ok: false, reason: 'mvp must be boolean' }
  }
  if (!Array.isArray(a.requiredMetadata)) {
    return { ok: false, reason: 'requiredMetadata must be an array' }
  }
  if (typeof a.signingStrategy !== 'string' || a.signingStrategy.length === 0) {
    return { ok: false, reason: 'signingStrategy must be a non-empty string' }
  }
  if (typeof a.implementedNow !== 'boolean') {
    return { ok: false, reason: 'implementedNow must be boolean' }
  }
  if (!allowedStrategies.includes(a.signingStrategy)) {
    return { ok: false, reason: `unknown signing strategy: "${a.signingStrategy}"` }
  }
  if (forbiddenStrategies.includes(a.signingStrategy)) {
    return { ok: false, reason: `forbidden signing strategy: "${a.signingStrategy}"` }
  }
  // MVP artifacts must declare all three metadata requirements so the publish
  // workflow slice has an explicit contract to implement against.
  if (a.mvp === true) {
    const required = a.requiredMetadata as unknown[]
    for (const m of ['checksum', 'provenance', 'sbom']) {
      if (!required.includes(m)) {
        return { ok: false, reason: `MVP artifact must require "${m}" metadata` }
      }
    }
  }
  return { ok: true }
}

const policy = readJson('tests/e2e/distribution/supply-chain-policy.json') as SupplyChainPolicy

describe('supply-chain-policy.json structure', () => {
  it('has schemaVersion 1', () => {
    expect(policy.schemaVersion).toBe(1)
  })

  it('has non-empty artifacts array', () => {
    expect(Array.isArray(policy.artifacts)).toBe(true)
    expect(policy.artifacts.length).toBeGreaterThan(0)
  })

  it('has non-empty allowedSigningStrategies', () => {
    expect(Array.isArray(policy.allowedSigningStrategies)).toBe(true)
    expect(policy.allowedSigningStrategies.length).toBeGreaterThan(0)
  })

  it('has non-empty forbiddenSigningStrategies', () => {
    expect(Array.isArray(policy.forbiddenSigningStrategies)).toBe(true)
    expect(policy.forbiddenSigningStrategies.length).toBeGreaterThan(0)
  })

  it('each artifact passes validateArtifactPolicy', () => {
    for (const artifact of policy.artifacts) {
      const result = validateArtifactPolicy(
        artifact,
        policy.forbiddenSigningStrategies,
        policy.allowedSigningStrategies,
      )
      const reason = !result.ok ? ` (${result.reason})` : ''
      expect(result.ok, `artifact "${artifact.id}" failed validation${reason}`).toBe(true)
    }
  })

  it('artifact ids are unique', () => {
    const ids = policy.artifacts.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('supply-chain-policy.json MVP artifact classification', () => {
  it('npm-tarball is an MVP artifact', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'npm-tarball')
    expect(artifact, 'npm-tarball must be in the policy').toBeDefined()
    expect(artifact!.mvp).toBe(true)
  })

  it('docker-image is an MVP artifact', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'docker-image')
    expect(artifact, 'docker-image must be in the policy').toBeDefined()
    expect(artifact!.mvp).toBe(true)
  })
})

describe('supply-chain-policy.json CI implementation status', () => {
  it('npm-tarball ciImplemented is true (publish-mcp job in release.yml)', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'npm-tarball')
    expect(artifact?.ciImplemented, 'npm-tarball CI publish is implemented').toBe(true)
    expect(artifact?.ciJobId).toBe('publish-mcp')
    expect(artifact?.ciWorkflow).toBe('.github/workflows/release.yml')
  })

  it('docker-image ciImplemented is true (docker-publish-sign job in release.yml)', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'docker-image')
    expect(artifact?.ciImplemented, 'docker-image CI publish is implemented').toBe(true)
    expect(artifact?.ciJobId).toBe('docker-publish-sign')
    expect(artifact?.ciWorkflow).toBe('.github/workflows/release.yml')
  })

  it('npm-tarball implementedNow is false (locally-runnable gate not yet wired)', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'npm-tarball')
    expect(
      artifact?.implementedNow,
      'implementedNow:false = no locally-runnable gate in release-gate-matrix; CI implementation tracked via ciImplemented',
    ).toBe(false)
  })

  it('docker-image implementedNow is false (locally-runnable gate not yet wired)', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'docker-image')
    expect(
      artifact?.implementedNow,
      'implementedNow:false = no locally-runnable gate in release-gate-matrix; CI implementation tracked via ciImplemented',
    ).toBe(false)
  })

  it('non-MVP artifacts do not declare ciImplemented', () => {
    const nonMvp = policy.artifacts.filter((a) => !a.mvp)
    for (const artifact of nonMvp) {
      expect(
        artifact.ciImplemented,
        `non-MVP artifact "${artifact.id}" must not declare ciImplemented`,
      ).toBeUndefined()
    }
  })
})

describe('supply-chain-policy.json MVP artifact classification (non-MVP)', () => {
  it('deno-binary is not an MVP artifact', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'deno-binary')
    expect(artifact, 'deno-binary must be in the policy as a deferred entry').toBeDefined()
    expect(artifact!.mvp).toBe(false)
  })

  it('homebrew-formula is not an MVP artifact', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'homebrew-formula')
    expect(artifact, 'homebrew-formula must be in the policy as a deferred entry').toBeDefined()
    expect(artifact!.mvp).toBe(false)
  })

  it('standalone-binary is not an MVP artifact', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'standalone-binary')
    expect(artifact, 'standalone-binary must be in the policy as a deferred entry').toBeDefined()
    expect(artifact!.mvp).toBe(false)
  })
})

describe('supply-chain-policy.json MVP metadata requirements', () => {
  const mvpArtifacts = () => policy.artifacts.filter((a) => a.mvp)

  it('all MVP artifacts require checksum metadata', () => {
    for (const artifact of mvpArtifacts()) {
      expect(
        artifact.requiredMetadata,
        `MVP artifact "${artifact.id}" must require checksum`,
      ).toContain('checksum')
    }
  })

  it('all MVP artifacts require provenance metadata', () => {
    for (const artifact of mvpArtifacts()) {
      expect(
        artifact.requiredMetadata,
        `MVP artifact "${artifact.id}" must require provenance`,
      ).toContain('provenance')
    }
  })

  it('all MVP artifacts require sbom metadata', () => {
    for (const artifact of mvpArtifacts()) {
      expect(
        artifact.requiredMetadata,
        `MVP artifact "${artifact.id}" must require sbom`,
      ).toContain('sbom')
    }
  })
})

describe('supply-chain-policy.json signing strategy safety', () => {
  it('no artifact uses a forbidden signing strategy', () => {
    const forbidden = new Set(policy.forbiddenSigningStrategies)
    const violations = policy.artifacts
      .filter((a) => forbidden.has(a.signingStrategy))
      .map((a) => a.id)
    expect(violations).toEqual([])
  })

  it('all artifact signing strategies are from the allowed set', () => {
    const allowed = new Set(policy.allowedSigningStrategies)
    for (const artifact of policy.artifacts) {
      expect(
        allowed.has(artifact.signingStrategy),
        `artifact "${artifact.id}" uses unknown strategy "${artifact.signingStrategy}"`,
      ).toBe(true)
    }
  })

  it('forbidden strategies do not overlap with allowed strategies', () => {
    const forbidden = new Set(policy.forbiddenSigningStrategies)
    const overlaps = policy.allowedSigningStrategies.filter((s) => forbidden.has(s))
    expect(overlaps).toEqual([])
  })
})

describe('design note content drift', () => {
  const NOTE_PATH = 'packages/mcp-server/src/server/release/release-signing-provenance-sbom.md'
  const noteExists = existsSync(join(ROOT, NOTE_PATH))
  // Guard against missing file: tests below will still fail individually if missing,
  // but won't throw at collection time.
  const noteText = noteExists ? readText(NOTE_PATH) : ''

  it('design note exists at the expected path', () => {
    expect(noteExists, `design note must exist at ${NOTE_PATH}`).toBe(true)
  })

  it('design note mentions all MVP artifact ids from the policy', () => {
    const mvpIds = policy.artifacts.filter((a) => a.mvp).map((a) => a.id)
    for (const id of mvpIds) {
      expect(noteText, `design note must mention MVP artifact "${id}"`).toContain(id)
    }
  })

  it('design note mentions all deferred artifact ids from the policy', () => {
    const deferredIds = policy.artifacts.filter((a) => !a.mvp).map((a) => a.id)
    for (const id of deferredIds) {
      expect(noteText, `design note must mention deferred artifact "${id}"`).toContain(id)
    }
  })

  it('design note mentions all required metadata types from MVP artifacts', () => {
    const allMetadata = new Set(policy.artifacts.flatMap((a) => a.requiredMetadata))
    for (const m of allMetadata) {
      expect(noteText, `design note must mention required metadata type "${m}"`).toContain(m)
    }
  })

  it('design note mentions signing strategies used by MVP artifacts', () => {
    const mvpStrategies = new Set(
      policy.artifacts.filter((a) => a.mvp).map((a) => a.signingStrategy),
    )
    for (const strategy of mvpStrategies) {
      if (strategy === 'deferred') continue
      expect(noteText, `design note must mention signing strategy "${strategy}"`).toContain(
        strategy,
      )
    }
  })
})

describe('supply-chain-policy.json cross-reference to release gate matrix', () => {
  it('releaseGateMatrixRef points to an existing file', () => {
    const ref = policy.releaseGateMatrixRef
    expect(typeof ref).toBe('string')
    expect(existsSync(join(ROOT, ref)), `releaseGateMatrixRef "${ref}" must exist on disk`).toBe(
      true,
    )
  })

  it('releaseGateMatrixRef is the canonical gate matrix path', () => {
    expect(policy.releaseGateMatrixRef).toBe('tests/e2e/distribution/release-gate-matrix.json')
  })
})

describe('validateArtifactPolicy PBT', () => {
  const nonEmptyStr = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0)
  const allowedStrategy = fc.constantFrom('npm-provenance', 'keyless-cosign', 'deferred')
  const forbiddenStrategy = fc.constantFrom(
    'custom-crypto',
    'bespoke-signing',
    'hardcoded-key',
    'self-signed-cert',
  )
  const forbidden = ['custom-crypto', 'bespoke-signing', 'hardcoded-key', 'self-signed-cert']
  const allowed = ['npm-provenance', 'keyless-cosign', 'deferred']

  fcTest.prop(
    [
      fc.record({
        id: nonEmptyStr,
        description: nonEmptyStr,
        mvp: fc.constant(false),
        requiredMetadata: fc.array(nonEmptyStr),
        signingStrategy: allowedStrategy,
        implementedNow: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('valid non-MVP artifact with allowed strategy always passes', (artifact) => {
    expect(validateArtifactPolicy(artifact, forbidden, allowed).ok).toBe(true)
  })

  fcTest.prop(
    [
      fc.record({
        id: nonEmptyStr,
        description: nonEmptyStr,
        mvp: fc.boolean(),
        requiredMetadata: fc.array(nonEmptyStr),
        signingStrategy: forbiddenStrategy,
        implementedNow: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('artifact with forbidden signing strategy always fails validation', (artifact) => {
    // Forbidden strategies are not in the allowed set, so the validator rejects
    // them at the allowed-strategy check (before reaching the forbidden check).
    expect(validateArtifactPolicy(artifact, forbidden, allowed).ok).toBe(false)
  })

  fcTest.prop(
    [
      // MVP artifact missing at least one of checksum/provenance/sbom
      fc.record({
        id: nonEmptyStr,
        description: nonEmptyStr,
        mvp: fc.constant(true),
        // Arbitrary metadata array guaranteed to be missing at least one required entry
        requiredMetadata: fc
          .uniqueArray(fc.constantFrom('checksum', 'provenance', 'sbom', 'extra'), {
            maxLength: 2,
          })
          .filter(
            (arr) =>
              !arr.includes('checksum') || !arr.includes('provenance') || !arr.includes('sbom'),
          ),
        signingStrategy: allowedStrategy,
        implementedNow: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('MVP artifact missing a required metadata type always fails validation', (artifact) => {
    expect(validateArtifactPolicy(artifact, forbidden, allowed).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        id: nonEmptyStr,
        description: nonEmptyStr,
        mvp: fc.boolean(),
        requiredMetadata: fc.array(nonEmptyStr),
        // Any string not in the allowed set (filtered to exclude allowed and forbidden)
        signingStrategy: fc
          .string({ minLength: 1, maxLength: 32 })
          .filter((s) => !allowed.includes(s) && !forbidden.includes(s) && s.trim().length > 0),
        implementedNow: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('artifact with unknown signing strategy always fails validation', (artifact) => {
    expect(validateArtifactPolicy(artifact, forbidden, allowed).ok).toBe(false)
  })
})
