// Property catalog: SBOM artifact policy invariants.
// Drift guard:
//   - release.yml publish-mcp job has SBOM generation + upload steps.
//   - release.yml docker-publish-sign job has sbom:true and provenance:true (OCI attestations).
//   - generate-npm-sbom.mjs does not leak SBOM contents or credentials to stdout.
//   - Runbook (docs/contributing/releasing.md) covers required keywords.
// PBT: validateSbomSummary() catches malformed safe-stdout summary shapes.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

function readFile(relPath: string): string {
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

type ValidationResult = { ok: true } | { ok: false; reason: string }

// Validates the safe-stdout SBOM summary shape emitted by generate-npm-sbom.mjs.
// Decoupled from the script so PBT can exercise arbitrary inputs.
export function validateSbomSummary(summary: unknown): ValidationResult {
  if (typeof summary !== 'object' || summary === null) {
    return { ok: false, reason: 'summary must be an object' }
  }
  const s = summary as Record<string, unknown>
  if (s.ok !== true) {
    return { ok: false, reason: 'ok must be true' }
  }
  if (typeof s.sbomFile !== 'string' || s.sbomFile.length === 0) {
    return { ok: false, reason: 'sbomFile must be a non-empty string' }
  }
  if (typeof s.sbomBytes !== 'number' || s.sbomBytes <= 0) {
    return { ok: false, reason: 'sbomBytes must be a positive number' }
  }
  if (typeof s.tool !== 'string' || s.tool.length === 0) {
    return { ok: false, reason: 'tool must be a non-empty string' }
  }
  if (typeof s.checksum !== 'object' || s.checksum === null) {
    return { ok: false, reason: 'checksum must be an object' }
  }
  const cs = s.checksum as Record<string, unknown>
  if (typeof cs.algorithm !== 'string' || cs.algorithm.length === 0) {
    return { ok: false, reason: 'checksum.algorithm must be a non-empty string' }
  }
  if (typeof cs.hex !== 'string' || cs.hex.length === 0) {
    return { ok: false, reason: 'checksum.hex must be a non-empty string' }
  }
  return { ok: true }
}

// ── npm SBOM drift: release.yml publish-mcp job ──────────────────────────────

describe('npm SBOM step drift (release.yml publish-mcp job)', () => {
  const RELEASE_WORKFLOW = '.github/workflows/release.yml'

  const npmSection = () =>
    jobSection(readFile(RELEASE_WORKFLOW), 'publish-mcp', 'docker-publish-sign')

  it('npm job invokes the publish-gate runner (which runs generate:sbom:npm as a publish-tier gate)', () => {
    expect(npmSection()).toContain('pnpm publish-gate')
  })

  it('generate:sbom:npm is a publish-tier gate in release-gate-matrix.json', () => {
    const matrix = JSON.parse(readFile('tests/e2e/distribution/release-gate-matrix.json'))
    const gate = matrix.gates.find((g: { id: string }) => g.id === 'generate:sbom:npm')
    expect(gate, 'generate:sbom:npm gate must exist').toBeDefined()
    expect(gate.requiredFor).toContain('publish')
  })

  it('npm job contains upload-artifact step', () => {
    expect(npmSection()).toContain('upload-artifact')
  })

  it('check:release-candidate runs generate:sbom:npm before pnpm test (package.json ordering)', () => {
    const pkg = JSON.parse(readFile('package.json'))
    const script: string = pkg.scripts['check:release-candidate']
    const sbomIdx = script.indexOf('generate:sbom:npm')
    const testIdx = script.indexOf('pnpm test')
    expect(
      sbomIdx,
      'generate:sbom:npm must appear in check:release-candidate',
    ).toBeGreaterThanOrEqual(0)
    expect(testIdx, 'pnpm test must appear in check:release-candidate').toBeGreaterThanOrEqual(0)
    expect(sbomIdx, 'generate:sbom:npm must precede pnpm test').toBeLessThan(testIdx)
  })

  it('npm job publish-gate step appears before npm publish', () => {
    const section = npmSection()
    const publishGateIdx = section.indexOf('pnpm publish-gate')
    // Use `run: npm publish` to avoid matching the job `name:` field.
    const publishIdx = section.indexOf('npm publish "$TARBALL"')
    expect(publishGateIdx, 'pnpm publish-gate must be present in npm job').toBeGreaterThanOrEqual(0)
    expect(publishIdx, 'run: npm publish must be present').toBeGreaterThanOrEqual(0)
    expect(publishGateIdx, 'pnpm publish-gate must precede npm publish').toBeLessThan(publishIdx)
  })

  it('npm job upload-artifact appears before npm publish', () => {
    const section = npmSection()
    const uploadIdx = section.indexOf('upload-artifact')
    const publishIdx = section.indexOf('npm publish "$TARBALL"')
    expect(uploadIdx, 'SBOM upload must precede npm publish').toBeLessThan(publishIdx)
  })

  it('npm job upload step has if-no-files-found: error', () => {
    expect(npmSection()).toContain('if-no-files-found: error')
  })

  it('npm job upload step retains artifact for at least 30 days', () => {
    const section = npmSection()
    const retentionMatch = section.match(/retention-days:\s*(\d+)/)
    expect(retentionMatch, 'retention-days must be set for SBOM artifact').not.toBeNull()
    const days = Number(retentionMatch![1])
    expect(days, 'retention-days must be >= 30').toBeGreaterThanOrEqual(30)
  })
})

// ── Docker SBOM/provenance drift ─────────────────────────────────────────────

describe('Docker SBOM and provenance drift (release.yml docker-publish-sign job)', () => {
  const RELEASE_WORKFLOW = '.github/workflows/release.yml'

  const dockerSection = () => jobSection(readFile(RELEASE_WORKFLOW), 'docker-publish-sign')

  it('Docker job uses docker/build-push-action', () => {
    expect(dockerSection()).toContain('docker/build-push-action')
  })

  it('Docker job has sbom: true (OCI SBOM attestation)', () => {
    expect(dockerSection()).toContain('sbom: true')
  })

  it('Docker job has provenance: true (OCI provenance attestation)', () => {
    expect(dockerSection()).toContain('provenance: true')
  })

  it('Docker job uses cosign sign (keyless signing)', () => {
    expect(dockerSection()).toContain('cosign sign')
  })
})

// ── Runbook drift ─────────────────────────────────────────────────────────────

describe('runbook (docs/contributing/releasing.md) keyword drift', () => {
  const runbook = () => readFile('docs/contributing/releasing.md')

  it('runbook mentions production-npm environment', () => {
    expect(runbook()).toContain('production-npm')
  })

  it('runbook mentions production-docker environment', () => {
    expect(runbook()).toContain('production-docker')
  })

  it('runbook mentions mcp-server-v<semver> tag shape', () => {
    expect(runbook()).toContain('mcp-server-v')
  })

  it('runbook explains publish:npm-provenance placeholder', () => {
    expect(runbook()).toContain('publish:npm-provenance')
  })

  it('runbook explains publish:docker-sign placeholder', () => {
    expect(runbook()).toContain('publish:docker-sign')
  })

  it('runbook explains why implementedNow remains false', () => {
    expect(runbook()).toContain('implementedNow')
  })

  it('runbook covers SBOM artifact', () => {
    expect(runbook()).toContain('generate-npm-sbom')
  })

  it('runbook covers Docker sbom/provenance attestations', () => {
    expect(runbook()).toContain('sbom: true')
  })
})

// ── generate-npm-sbom.mjs non-leak contract ───────────────────────────────────

describe('generate-npm-sbom.mjs non-leak contract', () => {
  const script = () => readFile('packages/mcp-server/scripts/release/generate-npm-sbom.mjs')

  it('script does not contain Authorization header string', () => {
    expect(script()).not.toContain('Authorization')
  })

  it('script does not contain Bearer token pattern', () => {
    expect(script()).not.toMatch(/Bearer\s+[A-Za-z0-9]/)
  })

  it('script does not reference NODE_AUTH_TOKEN', () => {
    expect(script()).not.toContain('NODE_AUTH_TOKEN')
  })

  it('script does not reference NPM_TOKEN', () => {
    expect(script()).not.toContain('NPM_TOKEN')
  })

  it('script captures tool stdio with pipe for all slots (never inherit)', () => {
    const src = script()
    // The exact stdio array must be ['ignore', 'pipe', 'pipe'] so the tool's
    // stdout (dep names, SBOM content) and stderr are captured, not relayed.
    expect(src, "spawnSync must use ['ignore', 'pipe', 'pipe'] to capture all output").toContain(
      "['ignore', 'pipe', 'pipe']",
    )
    expect(
      src,
      "no stdio slot must use 'inherit' (would forward dep content to logs)",
    ).not.toContain("'inherit'")
  })

  it('script does not write raw tool output to process.stdout', () => {
    // The script must never forward result.stdout or result.stderr directly.
    const src = script()
    expect(src).not.toContain('process.stdout.write(result.stdout')
    expect(src).not.toContain('process.stdout.write(result.stderr')
  })

  it('script writes only a structured summary to stdout (not SBOM content)', () => {
    const src = script()
    // Exactly one process.stdout.write call exists.
    const writeMatches = [...src.matchAll(/process\.stdout\.write\(/g)]
    expect(writeMatches.length, 'exactly one process.stdout.write call').toBe(1)
    // The call must be the JSON.stringify summary (multi-line).
    const callStart = writeMatches[0].index!
    const callContext = src.slice(callStart, callStart + 300)
    expect(callContext, 'stdout write must use JSON.stringify').toContain('JSON.stringify')
  })

  it('script uses SBOM basename only in output (no full path)', () => {
    // The safe summary should use basename(SBOM_FILE), not the full absolute path.
    expect(script()).toContain('basename(SBOM_FILE)')
  })
})

// ── ci.yml dry-run SBOM regression safety ────────────────────────────────────

describe('ci.yml dry-run SBOM regression safety', () => {
  const CI_WORKFLOW = '.github/workflows/ci.yml'

  it('ci.yml dry-run-npm job does not contain generate:sbom:npm', () => {
    // SBOM generation in dry-run is premature; dry-run does not produce a publishable artifact.
    // SBOM generation only runs as a publish-tier gate via `pnpm publish-gate` (release.yml publish-mcp job).
    const section = jobSection(readFile(CI_WORKFLOW), 'dry-run-npm', 'dry-run-docker')
    expect(section).not.toContain('generate:sbom:npm')
  })

  it('ci.yml does not have id-token: write', () => {
    expect(readFile(CI_WORKFLOW)).not.toContain('id-token: write')
  })
})

// ── Generated SBOM content regression ────────────────────────────────────────
// `pnpm check:release-candidate` runs `pnpm generate:sbom:npm` before
// `pnpm test`, so these tests always run in the release-candidate path.
// In isolation (`pnpm test` only), they skip if the artifact is absent.

describe('generated SBOM content regression', () => {
  const SBOM_PATH = join(ROOT, 'packages/mcp-server/_artifacts/npm-sbom.cdx.json')
  const sbomExists = existsSync(SBOM_PATH)

  type CdxComponent = { name: string; group?: string; purl?: string }

  function loadSbomPurls(): string[] {
    const sbom = JSON.parse(readFile('packages/mcp-server/_artifacts/npm-sbom.cdx.json'))
    return (sbom.components ?? []).map((c: CdxComponent) => c.purl ?? '')
  }

  // CycloneDX puts the unscoped name in `name` and scope in `group`.
  // Matching against `purl` (e.g. "pkg:npm/%40vitest/ui@...") is more reliable.
  // Scope separator: `@` → `%40`, `/` is NOT encoded in the purl.

  it.runIf(sbomExists)('generated SBOM contains no known dev-only packages', () => {
    const purls = loadSbomPurls()
    const devOnlyPatterns = [
      'pkg:npm/vitest@', // vitest core
      '%40vitest/', // @vitest/* scoped
      'pkg:npm/jsdom@', // jsdom
      'pkg:npm/fast-check@', // fast-check core
      '%40fast-check/', // @fast-check/* scoped
      // @excalidraw/utils is intentionally NOT listed here: the headless
      // export renderer moved to canvas-render + resvg, dropping
      // @excalidraw/utils, happy-dom, and @napi-rs/canvas as production
      // deps. @excalidraw/excalidraw itself stays a legitimate runtime dep
      // (canvas-viewer / apps/web still use it), so its own SBOM entry is
      // expected and not flagged as dev-only here.
      '%40stryker-mutator/', // @stryker-mutator/* mutation testing
      'pkg:npm/playwright@', // playwright core
      '%40playwright/', // @playwright/* scoped
      '%40testing-library/', // @testing-library/* scoped
    ]
    for (const pattern of devOnlyPatterns) {
      const matches = purls.filter((p) => p.includes(pattern))
      expect(matches, `dev-only pattern "${pattern}" must not appear in SBOM`).toEqual([])
    }
  })

  it.runIf(sbomExists)('generated SBOM contains expected production packages', () => {
    const purls = loadSbomPurls()
    const prodPatterns = ['pkg:npm/hono@', 'pkg:npm/jose@', 'pkg:npm/zod@', 'pkg:npm/nanoid@']
    for (const pattern of prodPatterns) {
      expect(
        purls.some((p) => p.includes(pattern)),
        `production package "${pattern}" must be in SBOM`,
      ).toBe(true)
    }
  })
})

// ── validateSbomSummary PBT ───────────────────────────────────────────────────

describe('validateSbomSummary PBT', () => {
  const nonEmptyStr = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0)
  const posInt = fc.integer({ min: 1, max: 10_000_000 })

  fcTest.prop(
    [
      fc.record({
        ok: fc.constant(true),
        sbomFile: nonEmptyStr,
        sbomBytes: posInt,
        tool: nonEmptyStr,
        checksum: fc.record({
          algorithm: nonEmptyStr,
          hex: nonEmptyStr,
        }),
      }),
    ],
    withDefaults(),
  )('valid SBOM summary always passes validation', (summary) => {
    expect(validateSbomSummary(summary).ok).toBe(true)
  })

  fcTest.prop(
    [
      fc.record({
        ok: fc.constant(false),
        sbomFile: nonEmptyStr,
        sbomBytes: posInt,
        tool: nonEmptyStr,
        checksum: fc.record({ algorithm: nonEmptyStr, hex: nonEmptyStr }),
      }),
    ],
    withDefaults(),
  )('summary with ok:false always fails validation', (summary) => {
    expect(validateSbomSummary(summary).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        ok: fc.constant(true),
        sbomFile: nonEmptyStr,
        sbomBytes: fc.integer({ min: -1000, max: 0 }),
        tool: nonEmptyStr,
        checksum: fc.record({ algorithm: nonEmptyStr, hex: nonEmptyStr }),
      }),
    ],
    withDefaults(),
  )('summary with non-positive sbomBytes always fails validation', (summary) => {
    expect(validateSbomSummary(summary).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        ok: fc.constant(true),
        sbomFile: fc.constant(''),
        sbomBytes: posInt,
        tool: nonEmptyStr,
        checksum: fc.record({ algorithm: nonEmptyStr, hex: nonEmptyStr }),
      }),
    ],
    withDefaults(),
  )('summary with empty sbomFile always fails validation', (summary) => {
    expect(validateSbomSummary(summary).ok).toBe(false)
  })

  fcTest.prop(
    [fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.string())],
    withDefaults(),
  )('non-object summary always fails validation', (summary) => {
    expect(validateSbomSummary(summary).ok).toBe(false)
  })
})

describe('release.yml publish job step ordering hazards', () => {
  it('publish-mcp pre-checkout steps must not inherit the packages/mcp-server default cwd', () => {
    // publish-mcp sets defaults.run.working-directory: packages/mcp-server, but that
    // directory only exists after actions/checkout runs. Any run step placed before
    // checkout (e.g. Validate tag shape) must override with working-directory: .
    // or bash fails to start ("No such file or directory") — broke the v0.0.8 release.
    const releaseYml = readFile('.github/workflows/release.yml')
    const publishMcp = jobSection(releaseYml, 'publish-mcp', 'docker-publish-sign')
    expect(publishMcp, 'publish-mcp job must exist in release.yml').not.toBe('')
    const checkoutIdx = publishMcp.indexOf('actions/checkout@')
    expect(checkoutIdx, 'publish-mcp must have a checkout step').toBeGreaterThan(-1)
    const preCheckout = publishMcp.slice(0, checkoutIdx)
    // Every `run:` step before checkout needs an explicit working-directory
    // override. Assert PER STEP — matching against the whole pre-checkout block
    // would let one compliant step mask another step's missing override.
    const steps = preCheckout.split(/^ {6}- /m).slice(1)
    const runSteps = steps.filter((step) => /^\s*run:/m.test(step))
    expect(runSteps.length, 'expected at least one pre-checkout run step').toBeGreaterThan(0)
    for (const step of runSteps) {
      const stepName = step.match(/name:\s*(.*)/)?.[1] ?? step.slice(0, 40)
      expect(
        step,
        `pre-checkout step "${stepName.trim()}" must set working-directory: . (job default dir does not exist yet)`,
      ).toMatch(/working-directory:\s*\.\s*$/m)
    }
  })

  it('publish jobs extend the daemon startup timeout for CI cold starts', () => {
    // Packaged daemon cold-start (native modules, WASM, first-run migrations)
    // exceeds the 10s default on CI runners and killed the tarball smoke.
    const releaseYml = readFile('.github/workflows/release.yml')
    for (const [jobId, nextJobId] of [
      ['publish-mcp', 'docker-publish-sign'],
      ['docker-publish-sign', 'deploy-web'],
    ] as const) {
      const section = jobSection(releaseYml, jobId, nextJobId)
      expect(section, `${jobId} job must exist`).not.toBe('')
      expect(
        section,
        `${jobId} must set WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS for slow CI cold starts`,
      ).toContain('WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS')
      expect(
        section,
        `${jobId} must set WHITEBOARD_SMOKE_RPC_TIMEOUT_MS for slow CI cold starts`,
      ).toContain('WHITEBOARD_SMOKE_RPC_TIMEOUT_MS')
    }
  })

  it('every smoke RPC path honours WHITEBOARD_SMOKE_RPC_TIMEOUT_MS (first tools/call includes daemon spawn)', () => {
    // Each smoke that RPCs a freshly-spawned daemon has its own rpc() with a
    // deadline; under CI cold-start a hardcoded 20s expired ("RPC tools/call
    // timed out") even after the daemon-startup timeout was extended. Both the
    // standalone smoke:e2e AND the packaged tarball smoke (which runs through
    // mcp-e2e-checkpoint.smoke-impl.ts, NOT mcp-e2e-smoke.mjs) must read the
    // override — the tarball path being missed is exactly what broke v0.0.10/11.
    const rpcSmokeFiles = [
      'packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs',
      'packages/mcp-server/src/server/mcp/mcp-e2e-checkpoint.smoke-impl.ts',
    ]
    for (const rel of rpcSmokeFiles) {
      expect(
        readFile(rel),
        `${rel} must read WHITEBOARD_SMOKE_RPC_TIMEOUT_MS instead of hardcoding the RPC deadline`,
      ).toContain('WHITEBOARD_SMOKE_RPC_TIMEOUT_MS')
    }
  })
})

describe('generate-npm-sbom.mjs pnpm-run environment', () => {
  it('strips package-manager lifecycle env before spawning cyclonedx-npm', () => {
    // Under `pnpm run`, npm_execpath points at pnpm's CLI. cyclonedx-npm resolves
    // "npm" through npm_execpath, so without sanitization it runs `pnpm ls` and
    // fails (exit 254). The script must spawn cyclonedx-npm with a cleaned env.
    const script = readFile('packages/mcp-server/scripts/release/generate-npm-sbom.mjs')
    expect(script, 'script must strip npm_execpath from the spawn env').toContain('npm_execpath')
    expect(script, 'cyclonedx spawn must use the sanitized env').toMatch(/env:\s*cleanEnv/)
  })
})

describe('cyclonedx-npm version policy', () => {
  it('requires >= 5.x now that CI proves --ignore-npm-errors works on the deployed prod tree', () => {
    // Historically pinned to v4: @cyclonedx/cyclonedx-npm@5.0.0 was suspected of
    // treating npm ls ELSPROBLEMS as fatal even with --ignore-npm-errors, which
    // would break SBOM generation on the pnpm-deployed prod tree (devDependencies
    // are intentionally absent there).
    //
    // Verified fixed: the ci.yml `sbom-npm` job runs generate:sbom:npm against
    // this exact deployed-prod-tree path on every PR/push (Linux), and the
    // "generated SBOM content regression" tests above assert the output is
    // non-empty and contains real production components. That job is the
    // living proof this invariant holds — if a future cyclonedx-npm release
    // regresses --ignore-npm-errors, that CI job fails before this version
    // bound would need to move.
    //
    // Moving to >=5 also closes GHSA-v75r-vx73-82pj (shell injection via
    // --workspace, fixed in >=5.0.0); this repo never passes --workspace so the
    // advisory was not exploitable even on v4, but the newer line carries the
    // fix regardless.
    const rootPkg = JSON.parse(readFile('package.json')) as {
      devDependencies?: Record<string, string>
    }
    const version = rootPkg.devDependencies?.['@cyclonedx/cyclonedx-npm']
    expect(version, '@cyclonedx/cyclonedx-npm must be a root devDependency').toBeTruthy()
    expect(
      version,
      'must be >= 5.x — the ci.yml sbom-npm job is required to prove --ignore-npm-errors still works before bumping further',
    ).toMatch(/^\^?([5-9]|\d{2,})\./)
  })
})
