// Property catalog: publish dry-run policy invariants.
// Drift guard:
//   - futureGateId ↔ package.json scripts, futureGateId NOT in
//     release-gate-matrix (implementedNow: false)
//   - ci.yml has dry-run-npm and dry-run-docker jobs (consolidated from publish-dry-run.yml)
//   - ci.yml cleanliness: no id-token:write, no packages:write, no npm publish, no cosign sign
// PBT: validateFutureGateCoverage() and validateCiWorkflowPolicy() catch structural violations.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

const CI_WORKFLOW = '.github/workflows/ci.yml'

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf-8'))
}

function readWorkflow(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf-8')
}

function jobSection(text: string, jobId: string, nextJobId?: string): string {
  const marker = `  ${jobId}:`
  const start = text.indexOf(marker)
  if (start === -1) return ''
  if (nextJobId) {
    const nextMarker = `  ${nextJobId}:`
    const end = text.indexOf(nextMarker, start)
    return end === -1 ? text.slice(start) : text.slice(start, end)
  }
  return text.slice(start)
}

interface ArtifactPolicy {
  id: string
  mvp: boolean
  implementedNow: boolean
  futureGateId?: string
}

interface SupplyChainPolicy {
  artifacts: ArtifactPolicy[]
}

interface GateMatrix {
  gates: Array<{ id: string }>
}

type ValidationResult = { ok: true } | { ok: false; reason: string }

// Pure validator for a single artifact's futureGateId coverage.
// Rules:
//   1. If no futureGateId, nothing to check.
//   2. futureGateId must exist in packageScripts.
//   3. When implementedNow is false, futureGateId must NOT appear in matrixGateIds
//      (a deferred gate has no release-gate entry yet).
export function validateFutureGateCoverage(
  artifact: { futureGateId?: string; implementedNow: boolean },
  packageScripts: Record<string, string>,
  matrixGateIds: string[],
): ValidationResult {
  const { futureGateId, implementedNow } = artifact
  if (!futureGateId) return { ok: true }

  if (!Object.hasOwn(packageScripts, futureGateId)) {
    return {
      ok: false,
      reason: `futureGateId "${futureGateId}" is not declared as a package.json script`,
    }
  }

  if (!implementedNow && matrixGateIds.includes(futureGateId)) {
    return {
      ok: false,
      reason: `futureGateId "${futureGateId}" appears in release-gate-matrix but implementedNow is false`,
    }
  }

  return { ok: true }
}

// Pure structural validator for ci.yml cleanliness invariants.
// ci.yml is the non-destructive verification path and must never carry publish
// capabilities — OIDC tokens, registry push, signing — that belong in release.yml.
export function validateCiWorkflowPolicy(workflow: {
  hasIdToken: boolean
  hasNpmPublish: boolean
  hasCosignSign: boolean
  hasPackagesWrite: boolean
}): ValidationResult {
  if (workflow.hasIdToken) {
    return { ok: false, reason: 'ci.yml must not grant id-token: write' }
  }
  if (workflow.hasNpmPublish) {
    return { ok: false, reason: 'ci.yml must not run npm publish' }
  }
  if (workflow.hasCosignSign) {
    return { ok: false, reason: 'ci.yml must not run cosign sign' }
  }
  if (workflow.hasPackagesWrite) {
    return { ok: false, reason: 'ci.yml must not grant packages: write' }
  }
  return { ok: true }
}

const policy = readJson('tests/e2e/distribution/supply-chain-policy.json') as SupplyChainPolicy
const matrix = readJson('tests/e2e/distribution/release-gate-matrix.json') as GateMatrix
const rootPkg = readJson('package.json') as { scripts: Record<string, string> }

const matrixGateIds = matrix.gates.map((g) => g.id)
const packageScripts = rootPkg.scripts

// ── Package.json script existence ─────────────────────────────────────────────

describe('publish dry-run scripts exist in package.json', () => {
  it('publish:dry-run:npm is declared', () => {
    expect(packageScripts).toHaveProperty('publish:dry-run:npm')
  })

  it('publish:dry-run:docker is declared', () => {
    expect(packageScripts).toHaveProperty('publish:dry-run:docker')
  })

  it('publish:dry-run is declared', () => {
    expect(packageScripts).toHaveProperty('publish:dry-run')
  })

  it('publish:npm-provenance placeholder is declared', () => {
    expect(packageScripts).toHaveProperty('publish:npm-provenance')
  })

  it('publish:docker-sign placeholder is declared', () => {
    expect(packageScripts).toHaveProperty('publish:docker-sign')
  })
})

// ── futureGateId ↔ package.json scripts coverage ─────────────────────────────

describe('futureGateId ↔ package.json scripts coverage', () => {
  it('each MVP artifact with a futureGateId has a matching package.json script', () => {
    for (const artifact of policy.artifacts.filter((a) => a.mvp && a.futureGateId)) {
      expect(
        packageScripts,
        `artifact "${artifact.id}" futureGateId "${artifact.futureGateId}" not found in package.json scripts`,
      ).toHaveProperty(artifact.futureGateId!)
    }
  })

  it('each artifact with a futureGateId passes validateFutureGateCoverage', () => {
    for (const artifact of policy.artifacts.filter((a) => a.futureGateId)) {
      const result = validateFutureGateCoverage(artifact, packageScripts, matrixGateIds)
      const reason = !result.ok ? ` (${result.reason})` : ''
      expect(
        result.ok,
        `artifact "${artifact.id}" failed futureGateId coverage check${reason}`,
      ).toBe(true)
    }
  })
})

// ── futureGateId NOT in release-gate-matrix ───────────────────────────────────

describe('futureGateId NOT in release-gate-matrix (implementedNow: false)', () => {
  it('publish:npm-provenance is not in release-gate-matrix', () => {
    expect(matrixGateIds).not.toContain('publish:npm-provenance')
  })

  it('publish:docker-sign is not in release-gate-matrix', () => {
    expect(matrixGateIds).not.toContain('publish:docker-sign')
  })

  it('no deferred artifact futureGateId appears in release-gate-matrix', () => {
    const violations = policy.artifacts
      .filter((a) => !a.implementedNow && a.futureGateId && matrixGateIds.includes(a.futureGateId))
      .map((a) => a.id)
    expect(
      violations,
      'deferred futureGateIds must not be in release-gate-matrix until implementedNow is true',
    ).toEqual([])
  })
})

// ── implementedNow is still false ─────────────────────────────────────────────

describe('implementedNow is false — locally-runnable gate not yet wired', () => {
  it('npm-tarball implementedNow is false (CI publish is live via ciImplemented; no gate-matrix entry)', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'npm-tarball')
    expect(artifact, 'npm-tarball must be in the policy').toBeDefined()
    expect(artifact!.implementedNow).toBe(false)
  })

  it('docker-image implementedNow is false (CI publish is live via ciImplemented; no gate-matrix entry)', () => {
    const artifact = policy.artifacts.find((a) => a.id === 'docker-image')
    expect(artifact, 'docker-image must be in the policy').toBeDefined()
    expect(artifact!.implementedNow).toBe(false)
  })
})

// ── ci.yml dry-run job existence ──────────────────────────────────────────────

describe('ci.yml dry-run jobs exist (consolidated from publish-dry-run.yml)', () => {
  it('dry-run-npm job exists in ci.yml', () => {
    expect(readWorkflow(CI_WORKFLOW), 'dry-run-npm job must exist in ci.yml').toContain(
      '  dry-run-npm:',
    )
  })

  it('dry-run-docker job exists in ci.yml', () => {
    expect(readWorkflow(CI_WORKFLOW), 'dry-run-docker job must exist in ci.yml').toContain(
      '  dry-run-docker:',
    )
  })

  it('dry-run-npm job references publish:dry-run:npm', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-npm', 'dry-run-docker')
    expect(section).toContain('publish:dry-run:npm')
  })

  it('dry-run-docker job references publish:dry-run:docker', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-docker')
    expect(section).toContain('publish:dry-run:docker')
  })
})

// ── ci.yml dry-run artifact uploads ──────────────────────────────────────────

describe('ci.yml dry-run jobs upload artifacts', () => {
  it('dry-run-npm job uploads artifacts via actions/upload-artifact', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-npm', 'dry-run-docker')
    expect(section).toContain('actions/upload-artifact')
  })

  it('dry-run-npm artifact name contains npm-tarball-dry-run', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-npm', 'dry-run-docker')
    expect(section).toContain('name: npm-tarball-dry-run-')
  })

  it('dry-run-npm artifact path is the publish-dry-run directory', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-npm', 'dry-run-docker')
    expect(section).toContain('path: packages/mcp-server/tmp/publish-dry-run/')
  })

  it('dry-run-npm artifact upload fails the job if no files are found', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-npm', 'dry-run-docker')
    expect(section).toContain('if-no-files-found: error')
  })

  it('dry-run-docker job uploads metadata via actions/upload-artifact', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-docker')
    expect(section).toContain('actions/upload-artifact')
  })

  it('dry-run-docker artifact name contains docker-image-dry-run', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-docker')
    expect(section).toContain('name: docker-image-dry-run-')
  })

  it('dry-run-docker artifact path is the docker metadata JSON', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-docker')
    expect(section).toContain(
      'path: packages/mcp-server/tmp/publish-dry-run/docker-image-metadata.json',
    )
  })

  it('dry-run-docker artifact upload warns if no files are found (metadata may be absent for unchanged images)', () => {
    const section = jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-docker')
    expect(section).toContain('if-no-files-found: warn')
  })
})

// ── ci.yml cleanliness ────────────────────────────────────────────────────────

describe('ci.yml cleanliness (no publish/sign/OIDC capabilities)', () => {
  it('ci.yml does not grant id-token: write', () => {
    expect(
      readWorkflow(CI_WORKFLOW),
      'ci.yml must not grant id-token: write — OIDC belongs in release.yml',
    ).not.toContain('id-token: write')
  })

  it('ci.yml does not run npm publish', () => {
    // Check for `run: npm publish` (not pnpm wrapper scripts whose names contain "npm").
    expect(
      readWorkflow(CI_WORKFLOW),
      'ci.yml must not run npm publish — publish belongs in release.yml',
    ).not.toContain('run: npm publish')
  })

  it('ci.yml does not run cosign sign', () => {
    // Check for `run: cosign sign` (not comments that mention "cosign signing").
    expect(
      readWorkflow(CI_WORKFLOW),
      'ci.yml must not run cosign sign — keyless signing belongs in release.yml',
    ).not.toContain('run: cosign sign')
  })

  it('ci.yml does not grant packages: write', () => {
    expect(
      readWorkflow(CI_WORKFLOW),
      'ci.yml must not grant packages: write — GHCR push belongs in release.yml',
    ).not.toContain('packages: write')
  })
})

// ── publish:dry-run aggregate contract ───────────────────────────────────────

describe('publish:dry-run aggregate contract', () => {
  function dryRunSegments(): string[] {
    const script = packageScripts['publish:dry-run'] ?? ''
    return script
      .split('&&')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  it('publish:dry-run contains pnpm publish:dry-run:npm', () => {
    expect(dryRunSegments()).toContain('pnpm publish:dry-run:npm')
  })

  it('publish:dry-run contains pnpm publish:dry-run:docker', () => {
    expect(dryRunSegments()).toContain('pnpm publish:dry-run:docker')
  })

  it('publish:dry-run:npm runs before publish:dry-run:docker', () => {
    const segs = dryRunSegments()
    const npmIdx = segs.indexOf('pnpm publish:dry-run:npm')
    const dockerIdx = segs.indexOf('pnpm publish:dry-run:docker')
    expect(npmIdx, 'pnpm publish:dry-run:npm must be present').toBeGreaterThanOrEqual(0)
    expect(dockerIdx, 'pnpm publish:dry-run:docker must be present').toBeGreaterThanOrEqual(0)
    expect(npmIdx, 'npm dry-run must precede docker dry-run').toBeLessThan(dockerIdx)
  })
})

// ── dry-run-docker job setup drift (ci.yml) ───────────────────────────────────

describe('dry-run-docker job setup drift (ci.yml)', () => {
  const dockerSection = () => jobSection(readWorkflow(CI_WORKFLOW), 'dry-run-docker')

  it('docker dry-run job uses the shared setup-pnpm composite action', () => {
    expect(dockerSection()).toContain('./.github/actions/setup-pnpm')
  })

  it('docker dry-run job runs pnpm install --frozen-lockfile', () => {
    expect(dockerSection()).toContain('pnpm install --frozen-lockfile')
  })

  it('docker dry-run job does not push to registry', () => {
    expect(dockerSection(), 'docker dry-run must not push to registry').not.toContain('push: true')
  })
})

// ── validateFutureGateCoverage PBT ───────────────────────────────────────────

describe('validateFutureGateCoverage PBT', () => {
  const nonEmptyStr = fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0)

  fcTest.prop(
    [
      fc.record({
        implementedNow: fc.boolean(),
      }),
      fc.dictionary(nonEmptyStr, nonEmptyStr),
      fc.array(nonEmptyStr),
    ],
    withDefaults(),
  )('artifact without futureGateId always passes', (artifact, scripts, gateIds) => {
    expect(validateFutureGateCoverage(artifact, scripts, gateIds).ok).toBe(true)
  })

  fcTest.prop(
    [
      fc.record({
        futureGateId: nonEmptyStr,
        implementedNow: fc.constant(false),
      }),
      fc.array(nonEmptyStr),
    ],
    withDefaults(),
  )(
    'deferred artifact whose futureGateId is in scripts but not in matrix passes',
    (artifact, otherGateIds) => {
      const scripts = { [artifact.futureGateId]: 'some-command' }
      const matrixIds = otherGateIds.filter((id) => id !== artifact.futureGateId)
      expect(validateFutureGateCoverage(artifact, scripts, matrixIds).ok).toBe(true)
    },
  )

  fcTest.prop(
    [
      fc.record({
        futureGateId: nonEmptyStr,
        implementedNow: fc.boolean(),
      }),
      fc.dictionary(nonEmptyStr, nonEmptyStr),
      fc.array(nonEmptyStr),
    ],
    withDefaults(),
  )(
    'artifact whose futureGateId is absent from scripts always fails',
    (artifact, scripts, gateIds) => {
      const sanitisedScripts = Object.fromEntries(
        Object.entries(scripts).filter(([k]) => k !== artifact.futureGateId),
      )
      expect(validateFutureGateCoverage(artifact, sanitisedScripts, gateIds).ok).toBe(false)
    },
  )

  fcTest.prop(
    [
      fc.record({
        futureGateId: nonEmptyStr,
        implementedNow: fc.constant(false),
      }),
    ],
    withDefaults(),
  )('deferred artifact whose futureGateId is already in matrix fails', (artifact) => {
    const scripts = { [artifact.futureGateId]: 'some-command' }
    const matrixIds = [artifact.futureGateId]
    expect(validateFutureGateCoverage(artifact, scripts, matrixIds).ok).toBe(false)
  })
})

// ── validateCiWorkflowPolicy PBT ──────────────────────────────────────────────

describe('validateCiWorkflowPolicy PBT', () => {
  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(false),
        hasNpmPublish: fc.constant(false),
        hasCosignSign: fc.constant(false),
        hasPackagesWrite: fc.constant(false),
      }),
    ],
    withDefaults(),
  )('fully clean ci.yml always passes', (workflow) => {
    expect(validateCiWorkflowPolicy(workflow).ok).toBe(true)
  })

  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(true),
        hasNpmPublish: fc.boolean(),
        hasCosignSign: fc.boolean(),
        hasPackagesWrite: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('workflow with id-token always fails', (workflow) => {
    expect(validateCiWorkflowPolicy(workflow).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(false),
        hasNpmPublish: fc.constant(true),
        hasCosignSign: fc.boolean(),
        hasPackagesWrite: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('workflow with npm publish always fails', (workflow) => {
    expect(validateCiWorkflowPolicy(workflow).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(false),
        hasNpmPublish: fc.constant(false),
        hasCosignSign: fc.constant(true),
        hasPackagesWrite: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('workflow with cosign sign always fails', (workflow) => {
    expect(validateCiWorkflowPolicy(workflow).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(false),
        hasNpmPublish: fc.constant(false),
        hasCosignSign: fc.constant(false),
        hasPackagesWrite: fc.constant(true),
      }),
    ],
    withDefaults(),
  )('workflow with packages: write always fails', (workflow) => {
    expect(validateCiWorkflowPolicy(workflow).ok).toBe(false)
  })
})
