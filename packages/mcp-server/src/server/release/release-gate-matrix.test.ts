// Property catalog: release gate matrix invariants.
// Drift guard: matrix ↔ package.json scripts ↔ README step count.
// PBT: validateGate() helper catches structural violations before they ship.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { repoRoot } from '../../shared/test-utils/repo-root.js'

const ROOT = repoRoot()

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf-8'))
}

function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf-8')
}

interface ReleaseGate {
  id: string
  command: string
  category: string
  requiredFor: string[]
  requiresDocker: boolean
  requiresNetwork: boolean
  expectedRuntimeBucket: string
}

interface GateMatrix {
  schemaVersion: number
  gates: ReleaseGate[]
}

// validateGate lives in tools/checks/src/release-gate-matrix-schema.mjs — the
// single validation authority shared with publish-gate.mjs and
// gate-isomorphism.test.ts. Importing it here (rather than re-implementing it)
// is what keeps this test and the runtime loader from drifting apart.
const SCHEMA_MODULE_PATH = join(ROOT, 'tools/checks/src/release-gate-matrix-schema.mjs')
const {
  validateGate,
  validateMatrix,
  KNOWN_CATEGORIES,
  KNOWN_RUNTIME_BUCKETS: KNOWN_BUCKETS,
} = (await import(pathToFileURL(SCHEMA_MODULE_PATH).href)) as {
  validateGate: (gate: unknown) => { ok: boolean; reason?: string }
  validateMatrix: (matrix: unknown) => { ok: boolean; reason?: string }
  KNOWN_CATEGORIES: Set<string>
  KNOWN_RUNTIME_BUCKETS: Set<string>
}

// Count distribution test steps from the test:e2e:distribution:only script.
function countDistributionSteps(script: string): number {
  return script
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean).length
}

// Split a shell script by && into trimmed, non-empty segments.
function scriptSegments(script: string): string[] {
  return script
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Returns true iff gate.command appears as an exact &&-segment in the script.
// Exact-segment matching prevents "pnpm test" from matching inside
// "pnpm test:e2e:distribution", and "smoke:docker" from matching inside
// "smoke:docker-backup-restore".
function isGatePresentAsSegment(script: string, gate: ReleaseGate): boolean {
  return scriptSegments(script).includes(gate.command)
}

const matrix = readJson('tests/e2e/distribution/release-gate-matrix.json') as GateMatrix
const rootPkg = readJson('package.json') as { scripts: Record<string, string> }
const readmeText = readText('tests/e2e/distribution/README.md')

// Authoritative step count for the distribution chain. Update this constant
// when a node smoke is added to or removed from test:e2e:distribution.
const EXPECTED_DISTRIBUTION_STEPS = 12

describe('release-gate-matrix.json structure', () => {
  // validateMatrix holds the schema version, the closed vocabularies, every
  // gate's rules and id uniqueness; release-gate-matrix-schema.test.ts holds
  // each rule on its own.
  it('passes the shared validator', () => {
    expect(validateMatrix(matrix)).toEqual({ ok: true })
  })
})

describe('release-gate-matrix.json safety invariants', () => {
  it('Docker-required gates are not required for ci', () => {
    const violations = matrix.gates
      .filter((g) => g.requiresDocker && g.requiredFor.includes('ci'))
      .map((g) => g.id)
    expect(violations).toEqual([])
  })

  it('Docker-required gates are not required for local-release', () => {
    const violations = matrix.gates
      .filter((g) => g.requiresDocker && g.requiredFor.includes('local-release'))
      .map((g) => g.id)
    expect(violations).toEqual([])
  })

  it('check:release-artifacts gate is present and required for ci', () => {
    const gate = matrix.gates.find((g) => g.id === 'check:release-artifacts')
    expect(gate, 'check:release-artifacts must be in the gate matrix').toBeDefined()
    expect(gate!.requiredFor).toContain('ci')
  })
})

describe('package.json script drift', () => {
  it('all plain pnpm gate commands reference an existing root script', () => {
    for (const gate of matrix.gates) {
      if (!gate.command.startsWith('pnpm ') || gate.command.includes('--filter')) continue
      const scriptName = gate.command.replace(/^pnpm\s+/, '')
      expect(
        rootPkg.scripts,
        `gate "${gate.id}" references missing root script "${scriptName}"`,
      ).toHaveProperty(scriptName)
    }
  })

  it('check:release-candidate exists in root package.json', () => {
    expect(rootPkg.scripts).toHaveProperty('check:release-candidate')
  })

  it('check:release-candidate:docker exists in root package.json', () => {
    expect(rootPkg.scripts).toHaveProperty('check:release-candidate:docker')
  })

  it('check:release-candidate:local exists in root package.json', () => {
    expect(rootPkg.scripts).toHaveProperty('check:release-candidate:local')
  })
})

const MCP_PACKAGE = 'packages/mcp-server'
const MCP_FILTER = 'pnpm --filter @kamiazya/whiteboard-mcp '
const mcpScripts = (readJson(`${MCP_PACKAGE}/package.json`) as { scripts: Record<string, string> })
  .scripts

/** A command a chain finally runs, and the directory it runs in. */
interface Leaf {
  command: string
  cwd: string
}

// A chain expanded through every script it names, root or mcp-server, down to
// the commands that actually run. A bare `pnpm <name>` names a script of the
// package the chain belongs to, so mcp-server's own chains resolve there.
function expandChain(command: string, cwd = '.'): Leaf[] {
  const scripts = cwd === '.' ? rootPkg.scripts : mcpScripts
  const own = /^pnpm ([\w:-]+)$/.exec(command)?.[1]
  if (own !== undefined && scripts[own] !== undefined) {
    return scriptSegments(scripts[own]).flatMap((segment) => expandChain(segment, cwd))
  }
  const mcp = command.startsWith(MCP_FILTER) ? command.slice(MCP_FILTER.length) : undefined
  if (mcp !== undefined && mcpScripts[mcp] !== undefined) {
    return scriptSegments(mcpScripts[mcp]).flatMap((segment) => expandChain(segment, MCP_PACKAGE))
  }
  return [{ command, cwd }]
}

const DISTRIBUTION_TESTS = readdirSync(join(ROOT, MCP_PACKAGE, 'src'), { recursive: true })
  .map(String)
  .filter((file) => file.endsWith('.distribution.test.ts'))
  .map((file) => join('src', file))

// The smoke implementations a leaf drives: a node script and a distribution
// test reach the same flow through the same `*.distribution-impl` module, so
// two leaves with different names can still be one smoke run twice.
function implementations(leaf: Leaf): string[] {
  const files = /--config vitest\.distribution\.config\.ts\b/.test(leaf.command)
    ? DISTRIBUTION_TESTS
    : (leaf.command.match(/\S+\.mjs\b/g) ?? [])
  const names = files.flatMap((file) => {
    const path = join(ROOT, leaf.cwd, file)
    if (!existsSync(path)) return []
    return [...readFileSync(path, 'utf-8').matchAll(/([\w-]+\.distribution-impl)\.[jt]s/g)].map(
      (m) => m[1] as string,
    )
  })
  return [...new Set(names)]
}

const repeated = (items: string[]): string[] => [
  ...new Set(items.filter((item, index) => items.indexOf(item) !== index)),
]

const TIER_RUNNERS = [
  'check:release-candidate',
  'check:release-candidate:local',
  'check:release-candidate:docker',
  'test:e2e:distribution',
]

// What each tier finally runs. The script tiers expand their runner script;
// the publish tier has no script — publish-gate.mjs runs its matrix gates in
// order — so it expands those gates' commands. CI's verify job is held to the
// same rule over its single-line `run:` steps.
const ciYml = readText('.github/workflows/ci.yml')
const verifyJob = /\n {2}verify:\n([\s\S]*?)\n {2}[a-z][\w-]*:\n/.exec(ciYml)?.[1] ?? ''
const TIER_CHAINS: Record<string, Leaf[]> = {
  'ci.yml verify job': [...verifyJob.matchAll(/^ +run: (pnpm [^|\n]+)$/gm)].flatMap((m) =>
    expandChain((m[1] as string).trim()),
  ),
  ...Object.fromEntries(TIER_RUNNERS.map((runner) => [runner, expandChain(`pnpm ${runner}`)])),
  'publish (publish-gate.mjs)': matrix.gates
    .filter((g) => g.requiredFor.includes('publish'))
    .flatMap((g) => expandChain(g.command)),
}
const leafKey = (leaf: Leaf): string => `${leaf.cwd}: ${leaf.command}`

describe('a tier runs each gate once', () => {
  it('expands every tier through its scripts into the smokes it drives', () => {
    for (const runner of TIER_RUNNERS) expect(rootPkg.scripts).toHaveProperty(runner)
    for (const leaves of Object.values(TIER_CHAINS)) {
      expect(leaves.length).toBeGreaterThan(8)
      expect(leaves.flatMap(implementations).length).toBeGreaterThanOrEqual(2)
    }
  })

  it.each(Object.keys(TIER_CHAINS))('%s runs no command twice', (tier) => {
    expect(repeated((TIER_CHAINS[tier] ?? []).map(leafKey))).toEqual([])
  })

  it.each(Object.keys(TIER_CHAINS))('%s drives no smoke implementation twice', (tier) => {
    expect(repeated((TIER_CHAINS[tier] ?? []).flatMap(implementations))).toEqual([])
  })
})

describe('tier aggregate completeness drift', () => {
  it('check:release-candidate covers every ci-required gate', () => {
    const commands = new Set((TIER_CHAINS['check:release-candidate'] ?? []).map(leafKey))
    const ciGates = matrix.gates.filter((g) => g.requiredFor.includes('ci'))
    expect(ciGates.length).toBeGreaterThan(5)
    for (const gate of ciGates) {
      expect(
        expandChain(gate.command).every((leaf) => commands.has(leafKey(leaf))),
        `check:release-candidate is missing ci-required gate "${gate.id}"`,
      ).toBe(true)
    }
  })

  it('check:release-candidate has pnpm build before check:release-artifacts', () => {
    const script = rootPkg.scripts['check:release-candidate'] ?? ''
    const parts = script.split('&&').map((s) => s.trim())
    const buildIdx = parts.findIndex((p) => /^pnpm build(\s|$)/.test(p))
    const artifactsIdx = parts.findIndex((p) => p.includes('check:release-artifacts'))
    expect(
      buildIdx,
      'pnpm build must be present in check:release-candidate',
    ).toBeGreaterThanOrEqual(0)
    expect(
      artifactsIdx,
      'check:release-artifacts must be present in check:release-candidate',
    ).toBeGreaterThanOrEqual(0)
    expect(buildIdx, 'pnpm build must run before check:release-artifacts').toBeLessThan(
      artifactsIdx,
    )
  })

  it('check:release-candidate:docker covers all docker-release-required gates', () => {
    const script = rootPkg.scripts['check:release-candidate:docker'] ?? ''
    const segs = scriptSegments(script)
    const dockerReleaseGates = matrix.gates.filter((g) => g.requiredFor.includes('docker-release'))
    for (const gate of dockerReleaseGates) {
      if (!gate.requiresDocker) {
        // Non-Docker gates are covered transitively via check:release-candidate.
        expect(
          segs,
          'check:release-candidate:docker must invoke check:release-candidate to cover non-Docker gates',
        ).toContain('pnpm check:release-candidate')
        continue
      }
      expect(
        isGatePresentAsSegment(script, gate),
        `check:release-candidate:docker is missing docker-release gate "${gate.id}"`,
      ).toBe(true)
    }
  })
})

describe('check:release-candidate Docker isolation drift', () => {
  it('check:release-candidate does not invoke any Docker-required gate command', () => {
    const script = rootPkg.scripts['check:release-candidate'] ?? ''
    const dockerGates = matrix.gates.filter((g) => g.requiresDocker)
    for (const gate of dockerGates) {
      expect(
        isGatePresentAsSegment(script, gate),
        `check:release-candidate must not contain Docker gate "${gate.id}"`,
      ).toBe(false)
    }
  })
})

describe('test:e2e:distribution step-count drift', () => {
  it('test:e2e:distribution delegates to build + :only', () => {
    const script = rootPkg.scripts['test:e2e:distribution']
    expect(script, 'test:e2e:distribution must exist in root package.json').toBeTruthy()
    const segs = scriptSegments(script)
    expect(segs).toContain('pnpm build')
    expect(segs).toContain('pnpm test:e2e:distribution:only')
  })

  it(`distribution:only chain has ${EXPECTED_DISTRIBUTION_STEPS} steps`, () => {
    const script = rootPkg.scripts['test:e2e:distribution:only']
    expect(script, 'test:e2e:distribution:only must exist in root package.json').toBeTruthy()
    expect(countDistributionSteps(script)).toBe(EXPECTED_DISTRIBUTION_STEPS)
  })

  it('README says "twelve steps" matching the current chain, and lists that many', () => {
    expect(readmeText).toMatch(/The chain has twelve steps/)
    // The sentence alone was once pinned while the list beneath it had a
    // different length: a count and a list drift apart unless one is read
    // off the other.
    const listed = readmeText.match(/^\d+\. /gm) ?? []
    expect(listed.length).toBe(EXPECTED_DISTRIBUTION_STEPS)
  })

  it('every `pnpm <script>` step in the chain resolves to a script that exists', () => {
    // The count above pinned the SHAPE of this chain and not its contents, so
    // a step naming a script that had been deleted stayed in it and the guard
    // stayed green. `pnpm smoke:template` sat there until someone ran the
    // chain — and it only runs on a release tag, since CI's packaged-smoke job
    // exercises `smoke:distribution:packaged:node` instead. Nothing else would have
    // reported it before the release it broke.
    //
    // Scoped to this chain, beside the count it completes.
    // `root-composite-scripts.test.ts` applies the same rule to every root
    // composite script, so a dangling step in `check:release-candidate` or
    // `check:local` is caught too.
    const chain = rootPkg.scripts['test:e2e:distribution:only'] ?? ''
    const missing = scriptSegments(chain)
      .map((segment) => /^pnpm ([\w:-]+)$/.exec(segment)?.[1])
      .filter((name): name is string => name !== undefined)
      .filter((name) => rootPkg.scripts[name] === undefined)
    expect(missing).toEqual([])
  })
})

// The two `publish:dry-run:*` jobs rehearse a publish on every pull request.
// They ran that way for months while appearing in NO tier of this matrix, so
// nothing tied their ci.yml steps to a policy file — and `smoke:docker`'s
// prCoverage exception cited "the dry-run-docker job", a job the matrix had
// never heard of. The `publish-dry-run` tier is what those two gates belong
// to: its runner is the root `publish:dry-run` script, and it is deliberately
// disjoint from every other tier. Release-candidate aggregates must not
// rehearse a publish, and `publish-gate.mjs` (which EXECUTES every
// `publish` gate) must not re-run the rehearsal during the real publish.
describe('publish-dry-run tier wiring drift', () => {
  const dryRunGates = matrix.gates.filter((g) => g.requiredFor.includes('publish-dry-run'))

  it('has at least one publish-dry-run-required gate in the matrix', () => {
    expect(dryRunGates.length, 'at least one publish-dry-run gate must exist').toBeGreaterThan(0)
  })

  it('publish-dry-run gates are not mixed into any other tier', () => {
    for (const gate of dryRunGates) {
      expect(
        gate.requiredFor,
        `publish-dry-run gate "${gate.id}" must not also be required for other tiers`,
      ).toEqual(['publish-dry-run'])
    }
  })

  it('root publish:dry-run covers every publish-dry-run gate as a command segment', () => {
    const script = rootPkg.scripts['publish:dry-run'] ?? ''
    for (const gate of dryRunGates) {
      expect(
        isGatePresentAsSegment(script, gate),
        `publish:dry-run is missing publish-dry-run gate "${gate.id}"`,
      ).toBe(true)
    }
  })

  it('check:release-candidate does not rehearse a publish', () => {
    const segs = scriptSegments(rootPkg.scripts['check:release-candidate'] ?? '')
    for (const gate of dryRunGates) {
      expect(
        segs,
        `check:release-candidate must not invoke publish-dry-run gate "${gate.id}"`,
      ).not.toContain(gate.command)
    }
  })
})

// The hosted web app (apps/web) Cloudflare Pages release gates run on the
// `pages-release` tier. The root `check:pages-release` command delegates to the
// private `@whiteboard/checks` tooling package, which executes the matrix's
// pages-release gates (matrix = policy, tools/checks = executor). They are kept off
// the ci / local-release / docker-release aggregates on purpose: smoke:preview-origin
// needs Playwright and a local 127.0.0.1 HTTP bind, so it stays a release-candidate
// adjacent gate rather than a normal PR/verify gate. What the runner DOES with the
// matrix (reads and validates it, runs the prerequisites, fails fast) is held over
// both tier entries by tools/arch-lint's publish-gate-runner.test.ts.
describe('pages-release tier wiring drift', () => {
  const pagesGates = matrix.gates.filter((g) => g.requiredFor.includes('pages-release'))

  it('has at least one pages-release-required gate in the matrix', () => {
    expect(pagesGates.length, 'at least one pages-release gate must exist').toBeGreaterThan(0)
  })

  it('pages-release gates are not mixed into the ci / local-release / docker-release aggregates', () => {
    for (const gate of pagesGates) {
      expect(
        gate.requiredFor,
        `pages-release gate "${gate.id}" must not also be required for other tiers`,
      ).toEqual(['pages-release'])
    }
  })

  it('root check:pages-release delegates to the @whiteboard/checks runner', () => {
    expect(rootPkg.scripts['check:pages-release']).toBe(
      'pnpm --filter @whiteboard/checks pages-release',
    )
  })

  it('@whiteboard/checks is a private package exposing a pages-release script', () => {
    const pkgPath = join(ROOT, 'tools/checks/package.json')
    expect(existsSync(pkgPath), 'tools/checks/package.json must exist').toBe(true)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      name?: string
      private?: boolean
      scripts?: Record<string, string>
    }
    expect(pkg.name, 'tools/checks must be named @whiteboard/checks').toBe('@whiteboard/checks')
    expect(pkg.private, 'tools/checks must be private (never published to npm)').toBe(true)
    expect(pkg.scripts?.['pages-release'], 'a pages-release script must exist').toBeTruthy()
  })

  it('pnpm-workspace.yaml includes tools/* so @whiteboard/checks resolves', () => {
    const workspace = readText('pnpm-workspace.yaml')
    expect(workspace, 'pnpm-workspace.yaml must declare tools/*').toMatch(/tools\/\*/)
  })
})

// The three vitest.distribution.config.ts specs (tarball / packaged / codex-config
// distribution tests) exercised a packed-tarball install and the packaged
// dist/server/mcp/stdio.js entry — the exact code path that broke a real npm
// publish (v0.0.9+) — yet ran only via manual `pnpm --filter
// @kamiazya/whiteboard-mcp test:distribution`, invisible to `pnpm test`,
// lefthook, and every release gate. This block guards that they stay wired.
describe('vitest.distribution.config.ts is wired into a release gate', () => {
  const mcpPkg = readJson('packages/mcp-server/package.json') as { scripts: Record<string, string> }

  it('mcp-server package.json exposes a build-free test:distribution:only script', () => {
    expect(mcpPkg.scripts).toHaveProperty('test:distribution:only')
    // Assert the exact script rather than a substring: a value like
    // "pnpm build && vitest run --config ..." would still contain the config
    // flag, silently reintroducing the inline build this script exists to avoid.
    expect(mcpPkg.scripts['test:distribution:only']).toBe(
      'vitest run --config vitest.distribution.config.ts',
    )
  })

  it('the matrix has a "test:distribution" gate covering the distribution vitest suite', () => {
    const gate = matrix.gates.find((g) => g.id === 'test:distribution')
    expect(gate, 'a "test:distribution" gate must exist in the release gate matrix').toBeDefined()
    expect(gate!.command).toBe('pnpm --filter @kamiazya/whiteboard-mcp test:distribution:only')
    for (const tier of ['ci', 'local-release', 'docker-release', 'publish']) {
      expect(gate!.requiredFor, `"test:distribution" must be required for "${tier}"`).toContain(
        tier,
      )
    }
  })

  it('check:release-candidate runs the "test:distribution" gate command', () => {
    const gate = matrix.gates.find((g) => g.id === 'test:distribution')
    expect(gate).toBeDefined()
    const script = rootPkg.scripts['check:release-candidate'] ?? ''
    expect(
      isGatePresentAsSegment(script, gate!),
      'check:release-candidate must run the distribution vitest suite',
    ).toBe(true)
  })
})

describe('validateGate PBT', () => {
  const nonEmptyStr = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0)
  const tier = fc.constantFrom<'ci' | 'local-release' | 'docker-release' | 'publish'>(
    'ci',
    'local-release',
    'docker-release',
    'publish',
  )
  const bucket = fc.constantFrom(...KNOWN_BUCKETS)
  const category = fc.constantFrom(...KNOWN_CATEGORIES)

  fcTest.prop(
    [
      fc.record({
        id: nonEmptyStr,
        command: nonEmptyStr,
        category,
        requiredFor: fc.uniqueArray(tier, { minLength: 1 }),
        requiresDocker: fc.constant(false),
        requiresNetwork: fc.boolean(),
        expectedRuntimeBucket: bucket,
      }),
    ],
    withDefaults(),
  )('valid non-Docker gate always passes validation', (gate) => {
    expect(validateGate(gate).ok).toBe(true)
  })

  fcTest.prop(
    [
      fc.record({
        id: nonEmptyStr,
        command: nonEmptyStr,
        category,
        requiredFor: fc.uniqueArray(tier, { minLength: 1 }).filter((arr) => arr.includes('ci')),
        requiresDocker: fc.constant(true),
        requiresNetwork: fc.boolean(),
        expectedRuntimeBucket: bucket,
      }),
    ],
    withDefaults(),
  )('Docker gate with ci in requiredFor always fails validation', (gate) => {
    expect(validateGate(gate).ok).toBe(false)
  })

  fcTest.prop(
    [
      fc.record({
        id: nonEmptyStr,
        command: nonEmptyStr,
        category,
        requiredFor: fc
          .uniqueArray(tier, { minLength: 1 })
          .filter((arr) => arr.includes('local-release')),
        requiresDocker: fc.constant(true),
        requiresNetwork: fc.boolean(),
        expectedRuntimeBucket: bucket,
      }),
    ],
    withDefaults(),
  )('Docker gate with local-release in requiredFor always fails validation', (gate) => {
    expect(validateGate(gate).ok).toBe(false)
  })

  fcTest.prop([fc.record({ id: fc.constant('') })], withDefaults())(
    'gate with empty id always fails validation',
    (gate) => {
      expect(validateGate(gate).ok).toBe(false)
    },
  )
})
