// Property catalog: production publish workflow policy invariants.
// Consolidated into release.yml: npm OIDC provenance + Docker keyless sign.
// Drift guards:
//   - permission model (id-token job-scoped), protected environments
//   - npm provenance path, Docker keyless signing path
//   - tag validation before checkout (both build jobs)
//   - SBOM generation / upload in the build job npm publish waits on
//   - standalone publish-production.yml and publish-dry-run.yml must not exist
// PBT: validateProductionJobPolicy() catches structural violations.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { jobSection } from '../../../../../tools/arch-lint/src/job-section.js'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { repoRoot } from '../../shared/test-utils/repo-root.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = repoRoot()

const RELEASE_WORKFLOW = '.github/workflows/release.yml'

function readWorkflow(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf-8')
}

type ValidationResult = { ok: true } | { ok: false; reason: string }

// Pure structural validator for a production publish job's required policy fields.
// Decoupled from YAML parsing so PBT can exercise it with arbitrary inputs.
export function validateProductionJobPolicy(job: {
  hasIdToken: boolean
  hasEnvironment: boolean
  hasReleaseGuard: boolean
  hasProvenanceCommand: boolean
}): ValidationResult {
  if (!job.hasIdToken) {
    return { ok: false, reason: 'publish job must have id-token: write' }
  }
  if (!job.hasEnvironment) {
    return { ok: false, reason: 'publish job must declare a protected environment' }
  }
  if (!job.hasReleaseGuard) {
    return { ok: false, reason: 'publish job must be gated by release trigger check' }
  }
  if (!job.hasProvenanceCommand) {
    return { ok: false, reason: 'publish job must use a provenance command' }
  }
  return { ok: true }
}

// ── Standalone workflow non-existence ─────────────────────────────────────────

describe('standalone publish workflows must not exist', () => {
  it('publish-production.yml is deleted (consolidated into release.yml)', () => {
    expect(
      existsSync(join(ROOT, '.github/workflows/publish-production.yml')),
      'publish-production.yml must not exist after consolidation into release.yml',
    ).toBe(false)
  })

  it('publish-dry-run.yml is deleted (dry-run consolidated into ci.yml)', () => {
    expect(
      existsSync(join(ROOT, '.github/workflows/publish-dry-run.yml')),
      'publish-dry-run.yml must not exist after consolidation into ci.yml',
    ).toBe(false)
  })
})

// ── release.yml workflow-level permission model ───────────────────────────────

describe('release.yml workflow-level permission model', () => {
  it('workflow root does not grant id-token: write', () => {
    const text = readWorkflow(RELEASE_WORKFLOW)
    const jobsIdx = text.indexOf('\njobs:')
    const preamble = jobsIdx === -1 ? text : text.slice(0, jobsIdx)
    expect(
      preamble,
      'id-token: write at workflow root grants OIDC to all jobs — must be job-scoped',
    ).not.toContain('id-token: write')
  })

  it('workflow root does not grant packages: write', () => {
    const text = readWorkflow(RELEASE_WORKFLOW)
    const jobsIdx = text.indexOf('\njobs:')
    const preamble = jobsIdx === -1 ? text : text.slice(0, jobsIdx)
    expect(
      preamble,
      'packages: write at workflow root would grant GHCR push to release-please — must be scoped to docker-publish-sign only',
    ).not.toMatch(/^\s{2}packages:\s+write/m)
  })
})

// ── release.yml publish-mcp job (npm) ─────────────────────────────────────────

describe('release.yml publish-mcp job policy (npm)', () => {
  const npmSection = () =>
    jobSection(readWorkflow(RELEASE_WORKFLOW), 'publish-mcp', 'docker-publish-sign')

  it('job has id-token: write', () => {
    expect(npmSection()).toContain('id-token: write')
  })

  it('job declares environment: production-npm', () => {
    expect(npmSection()).toContain('environment: production-npm')
  })

  it('job is gated by mcp_release_created', () => {
    expect(npmSection(), 'npm publish job must check mcp_release_created').toContain(
      'mcp_release_created',
    )
  })

  it('job is gated by force_publish_tag', () => {
    expect(npmSection(), 'npm publish job must check force_publish_tag').toContain(
      'force_publish_tag',
    )
  })

  it('job uses npm publish with --provenance flag', () => {
    const section = npmSection()
    expect(section).toContain('npm publish')
    expect(section, 'npm publish command must include --provenance flag').toContain('--provenance')
  })

  it('job runs no lifecycle script of the package it publishes', () => {
    expect(npmSection()).toMatch(/npm publish "\$TARBALL"[^\n]*--ignore-scripts/)
  })

  it('job does not reference NODE_AUTH_TOKEN as a secret', () => {
    expect(npmSection()).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{.*secrets\./)
  })

  it('job does not reference NPM_TOKEN as a secret', () => {
    expect(npmSection()).not.toMatch(/NPM_TOKEN:\s*\$\{\{.*secrets\./)
  })
})

// ── release.yml build-mcp tag validation ──────────────────────────────────────

const buildMcpSection = () =>
  jobSection(readWorkflow(RELEASE_WORKFLOW), 'build-mcp', 'build-docker')
const buildDockerSection = () =>
  jobSection(readWorkflow(RELEASE_WORKFLOW), 'build-docker', 'publish-mcp')

describe('release.yml build-mcp tag validation', () => {
  const npmSection = buildMcpSection

  it('tag validation step binds input via TAG env var (prevents shell injection)', () => {
    const section = npmSection()
    expect(section, 'tag validation must use TAG env var').toContain('TAG:')
    expect(section, 'shell must not expand expression inline').not.toContain('tag="${{ inputs.')
  })

  it('tag validation checks mcp-server-v<semver> shape', () => {
    expect(npmSection()).toContain('mcp-server-v[0-9]')
  })

  it('tag validation appears before checkout step', () => {
    const section = npmSection()
    const validationIdx = section.indexOf('mcp-server-v[0-9]')
    const checkoutIdx = section.indexOf('actions/checkout')
    expect(validationIdx, 'tag validation must be present').toBeGreaterThanOrEqual(0)
    expect(checkoutIdx, 'actions/checkout must be present').toBeGreaterThanOrEqual(0)
    expect(validationIdx, 'tag validation must appear before checkout').toBeLessThan(checkoutIdx)
  })
})

// ── release.yml build-mcp SBOM policy ────────────────────────────────────────

describe('release.yml build-mcp SBOM policy', () => {
  const npmSection = buildMcpSection

  it('SBOM generation is invoked via the publish-gate runner in the job npm publish waits on', () => {
    // generate:sbom:npm runs as a publish-tier gate inside `pnpm publish-gate`, not inline in the job.
    expect(npmSection(), 'pnpm publish-gate must be referenced in build-mcp').toContain(
      'pnpm publish-gate',
    )
    expect(
      jobSection(readWorkflow(RELEASE_WORKFLOW), 'publish-mcp', 'docker-publish-sign'),
      'publish-mcp must need build-mcp, so it runs only once the gate passed',
    ).toMatch(/needs:.*\bbuild-mcp\b/)
  })

  it('upload-artifact step uploads the SBOM', () => {
    expect(npmSection()).toContain('_artifacts/npm-sbom.cdx.json')
  })

  it('upload step has if-no-files-found: error', () => {
    expect(npmSection()).toContain('if-no-files-found: error')
  })

  it('upload step retains artifact for at least 30 days', () => {
    const section = npmSection()
    const retentionMatch = section.match(/retention-days:\s*(\d+)/)
    expect(retentionMatch, 'retention-days must be set for SBOM artifact').not.toBeNull()
    const days = Number(retentionMatch![1])
    expect(days, 'retention-days must be >= 30').toBeGreaterThanOrEqual(30)
  })
})

// ── release.yml build-mcp publish-gate collapse ───────────────────────────────
//
// The publish gate is scoped to publishability only: the full browser/jsdom
// `pnpm test` matrix must not re-run here, and every check the publish-gate
// runner already carries (typecheck, build, tarball/packaged smokes) must not
// also appear as a duplicate standalone step in the job.

describe('release.yml build-mcp job runs the publish-gate runner exactly once, with no duplicate standalone steps', () => {
  const npmSection = buildMcpSection

  it('does not contain a standalone `pnpm test` step (full browser/jsdom matrix)', () => {
    const section = npmSection()
    const lines = section.split('\n').map((l) => l.trim())
    const standaloneTest = lines.filter((l) => /^run:\s*pnpm test\s*$/.test(l))
    expect(standaloneTest, 'build-mcp must not run the full `pnpm test` matrix').toEqual([])
  })

  it('does not call check:release-candidate (which internally chains `pnpm test`)', () => {
    expect(npmSection()).not.toContain('check:release-candidate')
  })

  it('invokes `pnpm publish-gate` exactly once', () => {
    const section = npmSection()
    const matches = section.match(/run:\s*pnpm publish-gate\s*$/gm) ?? []
    expect(matches.length).toBe(1)
  })

  it.each([
    'pnpm typecheck',
    'pnpm build',
    'pnpm smoke:packaged',
    'pnpm smoke:tarball',
  ])('does not run "%s" as a standalone step of the npm build job', (command) => {
    const section = npmSection()
    const lines = section.split('\n').map((l) => l.trim())
    const standalone = lines.filter((l) => l === `run: ${command}`)
    expect(standalone, `"${command}" must not appear as a standalone step`).toEqual([])
  })
})

// ── release.yml build-docker and docker-publish-sign jobs ────────────────────

// The image's gate is scoped like the npm one: publishability plus what only a
// container can show. The full `pnpm test` matrix already ran on this SHA in
// verify CI, and re-running it on one runner at the tag turned every
// load-dependent test into a way to block the image — the 0.0.20 image failed
// three attempts that way, on three different tests, with npm already out.
describe('release.yml build-docker gates on publishability, not the full test matrix', () => {
  const dockerSection = buildDockerSection

  it('does not call check:release-candidate (which internally chains `pnpm test`)', () => {
    expect(dockerSection()).not.toContain('check:release-candidate')
  })

  it('invokes `pnpm publish-gate` exactly once', () => {
    expect(dockerSection().match(/run:\s*pnpm publish-gate\s*$/gm) ?? []).toHaveLength(1)
  })

  it.each([
    'pnpm smoke:docker',
    'pnpm smoke:docker-backup-restore',
  ])('runs "%s", which only a container can answer', (command) => {
    const lines = dockerSection()
      .split('\n')
      .map((l) => l.trim())
    expect(lines).toContain(`run: ${command}`)
  })
})

describe('release.yml docker-publish-sign job policy', () => {
  const dockerSection = () => jobSection(readWorkflow(RELEASE_WORKFLOW), 'docker-publish-sign')

  it('job is gated by mcp_release_created', () => {
    expect(dockerSection(), 'docker publish job must check mcp_release_created').toContain(
      'mcp_release_created',
    )
  })

  it('job is gated by force_publish_tag', () => {
    expect(dockerSection(), 'docker publish job must check force_publish_tag').toContain(
      'force_publish_tag',
    )
  })

  it('job has id-token: write', () => {
    expect(dockerSection()).toContain('id-token: write')
  })

  it('job has packages: write', () => {
    expect(dockerSection()).toContain('packages: write')
  })

  it('job declares environment: production-docker', () => {
    expect(dockerSection()).toContain('environment: production-docker')
  })

  it('build-docker uses sbom: true (OCI SBOM attestation)', () => {
    expect(buildDockerSection()).toContain('sbom: true')
  })

  it('build-docker uses provenance: true (OCI provenance attestation)', () => {
    expect(buildDockerSection()).toContain('provenance: true')
  })

  it('build-docker references docker/build-push-action', () => {
    expect(buildDockerSection()).toContain('docker/build-push-action')
  })

  it('job needs build-docker, so it pushes only an image that passed the gate', () => {
    expect(dockerSection()).toMatch(/needs:.*\bbuild-docker\b/)
  })

  it('job uses cosign sign (keyless signing)', () => {
    expect(dockerSection()).toContain('cosign sign')
  })

  it('job passes OIDC material via env vars, not inline shell expansion', () => {
    // DIGEST and IMAGE_REPO must be set as env vars; prevents token exposure in raw shell.
    expect(dockerSection()).toContain('DIGEST:')
    expect(dockerSection()).toContain('IMAGE_REPO:')
  })
})

describe('release.yml build-docker tag validation', () => {
  const dockerSection = buildDockerSection

  it('tag validation checks mcp-server-v<semver> shape before checkout', () => {
    const section = dockerSection()
    const validationIdx = section.indexOf('mcp-server-v[0-9]')
    const checkoutIdx = section.indexOf('actions/checkout')
    expect(validationIdx, 'tag validation must be present').toBeGreaterThanOrEqual(0)
    expect(checkoutIdx, 'actions/checkout must be present').toBeGreaterThanOrEqual(0)
    expect(validationIdx, 'tag validation must appear before checkout').toBeLessThan(checkoutIdx)
  })
})

// ── supply-chain policy implementedNow invariant ──────────────────────────────

describe('supply-chain policy implementedNow invariant', () => {
  it('npm-tarball implementedNow is false (locally-runnable gate not wired; CI tracked via ciImplemented)', () => {
    const pol = JSON.parse(
      readFileSync(join(ROOT, 'tests/e2e/distribution/supply-chain-policy.json'), 'utf-8'),
    )
    const artifact = pol.artifacts.find((a: { id: string }) => a.id === 'npm-tarball')
    // implementedNow:false = no entry in release-gate-matrix.json yet.
    // CI publish IS live — see ciImplemented:true and ciJobId:"publish-mcp".
    expect(artifact?.implementedNow).toBe(false)
  })

  it('docker-image implementedNow is false (locally-runnable gate not wired; CI tracked via ciImplemented)', () => {
    const pol = JSON.parse(
      readFileSync(join(ROOT, 'tests/e2e/distribution/supply-chain-policy.json'), 'utf-8'),
    )
    const artifact = pol.artifacts.find((a: { id: string }) => a.id === 'docker-image')
    // implementedNow:false = no entry in release-gate-matrix.json yet.
    // CI publish IS live — see ciImplemented:true and ciJobId:"docker-publish-sign".
    expect(artifact?.implementedNow).toBe(false)
  })
})

// ── validateProductionJobPolicy PBT ──────────────────────────────────────────

describe('validateProductionJobPolicy PBT', () => {
  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(true),
        hasEnvironment: fc.constant(true),
        hasReleaseGuard: fc.constant(true),
        hasProvenanceCommand: fc.constant(true),
      }),
    ],
    withDefaults(),
  )('fully compliant job always passes', (job) => {
    expect(validateProductionJobPolicy(job).ok).toBe(true)
  })

  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(false),
        hasEnvironment: fc.boolean(),
        hasReleaseGuard: fc.boolean(),
        hasProvenanceCommand: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('job without id-token always fails', (job) => {
    expect(validateProductionJobPolicy(job).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(true),
        hasEnvironment: fc.constant(false),
        hasReleaseGuard: fc.boolean(),
        hasProvenanceCommand: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('job without protected environment always fails', (job) => {
    expect(validateProductionJobPolicy(job).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(true),
        hasEnvironment: fc.constant(true),
        hasReleaseGuard: fc.constant(false),
        hasProvenanceCommand: fc.boolean(),
      }),
    ],
    withDefaults(),
  )('job without release guard always fails', (job) => {
    expect(validateProductionJobPolicy(job).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        hasIdToken: fc.constant(true),
        hasEnvironment: fc.constant(true),
        hasReleaseGuard: fc.constant(true),
        hasProvenanceCommand: fc.constant(false),
      }),
    ],
    withDefaults(),
  )('job without provenance command always fails', (job) => {
    expect(validateProductionJobPolicy(job).ok).toBe(false)
  })
})
