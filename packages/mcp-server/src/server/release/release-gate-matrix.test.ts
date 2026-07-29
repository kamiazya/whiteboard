// Property catalog: release gate matrix invariants.
// Drift guard: matrix ↔ package.json scripts ↔ README step count.
// PBT: validateGate() helper catches structural violations before they ship.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
const SCHEMA_MODULE_PATH = join(
  __dirname,
  '../../../../../tools/checks/src/release-gate-matrix-schema.mjs',
)
const {
  validateGate,
  KNOWN_CATEGORIES,
  KNOWN_RUNTIME_BUCKETS: KNOWN_BUCKETS,
  KNOWN_REQUIRED_FOR_TIERS: KNOWN_TIERS,
} = (await import(pathToFileURL(SCHEMA_MODULE_PATH).href)) as {
  validateGate: (gate: unknown) => { ok: boolean; reason?: string }
  KNOWN_CATEGORIES: Set<string>
  KNOWN_RUNTIME_BUCKETS: Set<string>
  KNOWN_REQUIRED_FOR_TIERS: Set<string>
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
// when a new node smoke is added to test:e2e:distribution.
const EXPECTED_DISTRIBUTION_STEPS = 16

describe('release-gate-matrix.json structure', () => {
  it('has schemaVersion 1', () => {
    expect(matrix.schemaVersion).toBe(1)
  })

  it('has non-empty gates array', () => {
    expect(Array.isArray(matrix.gates)).toBe(true)
    expect(matrix.gates.length).toBeGreaterThan(0)
  })

  it('each gate passes validateGate', () => {
    for (const gate of matrix.gates) {
      const result = validateGate(gate)
      const reason = !result.ok ? ` (${result.reason})` : ''
      expect(result.ok, `gate "${gate.id}" failed validation${reason}`).toBe(true)
    }
  })

  it('all categories are from the known set', () => {
    for (const gate of matrix.gates) {
      expect(
        KNOWN_CATEGORIES.has(gate.category),
        `unknown category "${gate.category}" on gate "${gate.id}"`,
      ).toBe(true)
    }
  })

  it('all expectedRuntimeBucket values are from the known set', () => {
    for (const gate of matrix.gates) {
      expect(
        KNOWN_BUCKETS.has(gate.expectedRuntimeBucket),
        `unknown bucket "${gate.expectedRuntimeBucket}" on gate "${gate.id}"`,
      ).toBe(true)
    }
  })

  it('all requiredFor tiers are from the known set', () => {
    for (const gate of matrix.gates) {
      for (const tier of gate.requiredFor) {
        expect(KNOWN_TIERS.has(tier), `unknown tier "${tier}" on gate "${gate.id}"`).toBe(true)
      }
    }
  })

  it('gate ids are unique', () => {
    const ids = matrix.gates.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
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

// smoke:tarball and smoke:packaged are invoked inside test:e2e:distribution;
// they do not need to appear directly in check:release-candidate.
const COVERED_VIA_DISTRIBUTION = new Set(['smoke:tarball', 'smoke:packaged'])

describe('tier aggregate completeness drift', () => {
  it('COVERED_VIA_DISTRIBUTION gates actually appear in test:e2e:distribution:only as command segments', () => {
    const distScript = rootPkg.scripts['test:e2e:distribution:only'] ?? ''
    for (const id of COVERED_VIA_DISTRIBUTION) {
      const gate = matrix.gates.find((g) => g.id === id)
      expect(gate, `gate "${id}" must be in the matrix`).toBeDefined()
      expect(
        isGatePresentAsSegment(distScript, gate!),
        `COVERED_VIA_DISTRIBUTION gate "${id}" not found as a command segment in test:e2e:distribution:only`,
      ).toBe(true)
    }
  })

  it('check:release-candidate covers all ci-required gates not delegated to test:e2e:distribution', () => {
    const script = rootPkg.scripts['check:release-candidate'] ?? ''
    const ciGates = matrix.gates.filter((g) => g.requiredFor.includes('ci'))
    for (const gate of ciGates) {
      if (COVERED_VIA_DISTRIBUTION.has(gate.id)) continue
      expect(
        isGatePresentAsSegment(script, gate),
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

  it('README says "sixteen steps" matching the current chain', () => {
    expect(readmeText).toMatch(/The chain has sixteen steps/)
  })
})

// The hosted web app (apps/web) Cloudflare Pages release gates run on the
// `pages-release` tier. The root `check:pages-release` command delegates to the
// private `@whiteboard/checks` tooling package, which executes the matrix's
// pages-release gates (matrix = policy, tools/checks = executor). They are kept off
// the ci / local-release / docker-release aggregates on purpose: smoke:preview-origin
// needs Playwright and a local 127.0.0.1 HTTP bind, so it stays a release-candidate
// adjacent gate rather than a normal PR/verify gate.
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

  it('the pages-release runner is matrix-driven (the matrix stays the single policy source)', () => {
    const runner = readText('tools/checks/src/pages-release.mjs')
    expect(
      runner,
      'runner must read release-gate-matrix.json instead of hardcoding gate commands',
    ).toContain('release-gate-matrix.json')
    expect(runner, 'runner must select the pages-release tier').toContain('pages-release')
  })

  it("the pages-release runner runs 'pnpm build' before the matrix gates", () => {
    const runner = readText('tools/checks/src/pages-release.mjs')
    expect(runner, "runner must run 'pnpm build' as a prerequisite step").toContain("'pnpm build'")
  })

  it('pnpm-workspace.yaml includes tools/* so @whiteboard/checks resolves', () => {
    const workspace = readText('pnpm-workspace.yaml')
    expect(workspace, 'pnpm-workspace.yaml must declare tools/*').toMatch(/tools\/\*/)
  })

  // A release gate runner must not run its gates on a typo'd flag.
  describe('runner argument handling', () => {
    const RUNNER = join(ROOT, 'tools/checks/src/pages-release.mjs')

    it('prints usage and exits 0 on --help (without running the gates)', () => {
      const r = spawnSync('node', [RUNNER, '--help'], { encoding: 'utf-8' })
      expect(r.status, '--help must exit 0').toBe(0)
      expect(r.stdout, '--help must print usage').toMatch(/Usage:/)
      expect(r.stdout, '--help must not start running build/smoke steps').not.toMatch(
        /\[pages-release] step/,
      )
    })

    it('exits 1 and prints usage on an unknown argument', () => {
      const r = spawnSync('node', [RUNNER, '--bogus'], { encoding: 'utf-8' })
      expect(r.status, 'unknown argument must exit 1').toBe(1)
      expect(`${r.stdout}${r.stderr}`, 'unknown argument must surface usage').toMatch(/Usage:/)
    })
  })

  // The runner builds spawnSync argv via splitCommand (no shell), so a matrix
  // command with shell metacharacters or env assignment is rejected, not executed.
  describe('splitCommand gate-command parser', () => {
    const importSplitCommand = async () => {
      const mod = await import(pathToFileURL(join(ROOT, 'tools/checks/src/split-command.mjs')).href)
      return mod.splitCommand as (command: string) => string[]
    }

    it('splits plain commands and collapses surrounding/repeated whitespace', async () => {
      const splitCommand = await importSplitCommand()
      expect(splitCommand('pnpm build')).toEqual(['pnpm', 'build'])
      expect(splitCommand('  pnpm   --filter  @kamiazya/whiteboard-web   smoke:artifact ')).toEqual(
        ['pnpm', '--filter', '@kamiazya/whiteboard-web', 'smoke:artifact'],
      )
    })

    it('rejects empty, shell-metachar, and env-assignment commands', async () => {
      const splitCommand = await importSplitCommand()
      expect(() => splitCommand('')).toThrow()
      expect(() => splitCommand('   ')).toThrow()
      expect(() => splitCommand('pnpm build && rm -rf /')).toThrow() // & metachar
      expect(() => splitCommand('echo $HOME')).toThrow() // $ substitution
      expect(() => splitCommand('cat "a b"')).toThrow() // quote
      expect(() => splitCommand('FOO=bar pnpm build')).toThrow() // env assignment
    })

    it('accepts every pages-release gate command in the matrix', async () => {
      const splitCommand = await importSplitCommand()
      for (const gate of pagesGates) {
        expect(
          () => splitCommand(gate.command),
          `gate "${gate.id}" must be shell-safe`,
        ).not.toThrow()
      }
    })
  })

  // Direct unit tests over the runner's core loop, using a fake spawn so ordering /
  // fail-fast logic is covered without a real build (the string `toContain` guards
  // above can't catch a mutation that reorders steps or keeps going after a failure).
  describe('runner core loop (planSteps / runSteps)', () => {
    type Step = { label: string; command: string }
    type FakeStatus = { status: number | null; error?: Error }
    const sink = { write: (_: string) => true }

    const importRunner = async () => {
      const mod = await import(pathToFileURL(join(ROOT, 'tools/checks/src/pages-release.mjs')).href)
      return mod as {
        planSteps: (gates: { id: string; command: string; requiredFor: string[] }[]) => Step[]
        runSteps: (
          steps: Step[],
          opts: {
            cwd?: string
            spawn: (cmd: string, args: string[], o: unknown) => FakeStatus
            stdout?: { write: (s: string) => boolean }
            stderr?: { write: (s: string) => boolean }
          },
        ) => { ok: boolean; exitCode: number; ranLabels: string[] }
      }
    }

    it('planSteps puts pnpm build first, then only the pages-release gates in matrix order', async () => {
      const { planSteps } = await importRunner()
      const steps = planSteps([
        { id: 'a', command: 'pnpm a', requiredFor: ['pages-release'] },
        { id: 'b', command: 'pnpm b', requiredFor: ['ci'] },
        { id: 'c', command: 'pnpm c', requiredFor: ['pages-release'] },
      ])
      expect(steps).toEqual([
        { label: 'build', command: 'pnpm build' },
        { label: 'a', command: 'pnpm a' },
        { label: 'c', command: 'pnpm c' },
      ])
    })

    it('runSteps spawns every step in order when all succeed', async () => {
      const { runSteps } = await importRunner()
      const calls: string[] = []
      const spawn = (cmd: string, args: string[]): FakeStatus => {
        calls.push(`${cmd} ${args.join(' ')}`.trim())
        return { status: 0 }
      }
      const r = runSteps(
        [
          { label: 'build', command: 'pnpm build' },
          { label: 'x', command: 'pnpm --filter @kamiazya/whiteboard-web smoke:artifact' },
        ],
        { cwd: '/repo', spawn, stdout: sink, stderr: sink },
      )
      expect(r.ok).toBe(true)
      expect(r.exitCode).toBe(0)
      expect(calls).toEqual(['pnpm build', 'pnpm --filter @kamiazya/whiteboard-web smoke:artifact'])
    })

    it('runSteps stops at the first non-zero exit (fail-fast) and returns that code', async () => {
      const { runSteps } = await importRunner()
      const calls: string[] = []
      const spawn = (cmd: string, args: string[]): FakeStatus => {
        calls.push(`${cmd} ${args.join(' ')}`.trim())
        return { status: args[0] === 'boom' ? 2 : 0 }
      }
      const r = runSteps(
        [
          { label: 'build', command: 'pnpm build' },
          { label: 'fails', command: 'pnpm boom' },
          { label: 'after', command: 'pnpm after' },
        ],
        { cwd: '/repo', spawn, stdout: sink, stderr: sink },
      )
      expect(r.ok).toBe(false)
      expect(r.exitCode).toBe(2)
      // 'pnpm after' must never be spawned after the failure.
      expect(calls).toEqual(['pnpm build', 'pnpm boom'])
      expect(r.ranLabels).toEqual(['build', 'fails'])
    })

    it('runSteps rejects a shell-unsafe gate command without spawning it', async () => {
      const { runSteps } = await importRunner()
      const calls: string[] = []
      const spawn = (cmd: string): FakeStatus => {
        calls.push(cmd)
        return { status: 0 }
      }
      const r = runSteps([{ label: 'evil', command: 'pnpm build && rm -rf /' }], {
        cwd: '/repo',
        spawn,
        stdout: sink,
        stderr: sink,
      })
      expect(r.ok).toBe(false)
      expect(calls).toEqual([])
    })

    it('runSteps stops when a step fails to spawn (spawn error)', async () => {
      const { runSteps } = await importRunner()
      const calls: string[] = []
      const spawn = (cmd: string, args: string[]): FakeStatus => {
        calls.push(`${cmd} ${args.join(' ')}`.trim())
        return { status: null, error: new Error('spawn ENOENT') }
      }
      const r = runSteps(
        [
          { label: 'build', command: 'pnpm build' },
          { label: 'after', command: 'pnpm after' },
        ],
        { cwd: '/repo', spawn, stdout: sink, stderr: sink },
      )
      expect(r.ok).toBe(false)
      expect(r.exitCode).toBe(1)
      // a spawn error aborts before the next step.
      expect(calls).toEqual(['pnpm build'])
    })

    it('planSteps returns only the build step when there are no pages-release gates', async () => {
      const { planSteps } = await importRunner()
      // main()'s `steps.length <= 1` no-gates guard relies on this shape.
      expect(planSteps([])).toEqual([{ label: 'build', command: 'pnpm build' }])
      expect(planSteps([{ id: 'x', command: 'pnpm x', requiredFor: ['ci'] }])).toEqual([
        { label: 'build', command: 'pnpm build' },
      ])
    })
  })
})

// The three vitest.distribution.config.ts specs (tarball / packaged / codex-config
// distribution tests) exercised a packed-tarball install and the packaged
// dist/server/mcp/index.js entry — the exact code path that broke a real npm
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
