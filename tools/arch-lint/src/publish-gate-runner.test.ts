// Publish gate: separates publishability from correctness.
//
// The `publish` tier of tests/e2e/distribution/release-gate-matrix.json is the
// single source of truth for what publish-mcp runs. tools/checks/src/publish-gate.mjs
// is a matrix-driven runner (mirrors pages-release.mjs) — it filters gates by
// requiredFor.includes('publish') and runs them in matrix order, fail-fast.
//
// Correctness authority for the removed browser/jsdom test matrix is verify CI
// at the identical tag SHA (see ci-verify-coverage.test.ts). The publish tier
// keeps only: publishability checks (build, artifact checks, SBOM, tarball/packaged
// smokes) and a fast non-flaky correctness floor (typecheck + mcp-node).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const ROOT = REPO_ROOT

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
}

interface GateMatrix {
  gates: ReleaseGate[]
}

const matrix = readJson('tests/e2e/distribution/release-gate-matrix.json') as GateMatrix
const rootPkg = readJson('package.json') as { scripts: Record<string, string> }
const publishGates = matrix.gates.filter((g) => g.requiredFor.includes('publish'))

describe('publish tier wiring', () => {
  it('has at least one publish-required gate in the matrix', () => {
    expect(publishGates.length).toBeGreaterThan(0)
  })

  it('the full browser/jsdom `pnpm test` gate is NOT requiredFor publish', () => {
    const testGate = matrix.gates.find((g) => g.id === 'test')
    expect(testGate, 'test gate must exist').toBeDefined()
    expect(testGate!.requiredFor).not.toContain('publish')
  })

  it('no browser or jsdom project gate is requiredFor publish', () => {
    const browserish = matrix.gates.filter(
      (g) =>
        g.requiredFor.includes('publish') &&
        (g.command.includes('mcp-browser') ||
          g.command.includes('mcp-jsdom') ||
          g.command.includes('web-browser')),
    )
    expect(browserish).toEqual([])
  })

  it('includes a typecheck gate', () => {
    const gate = matrix.gates.find((g) => g.id === 'typecheck')
    expect(gate, 'typecheck gate must exist').toBeDefined()
    expect(gate!.requiredFor).toContain('publish')
  })

  it('includes a fast node-only correctness floor gate (test:mcp-node) scoped to mcp-node only', () => {
    const gate = publishGates.find((g) => g.id === 'test:mcp-node')
    expect(gate, 'test:mcp-node gate must exist and be requiredFor publish').toBeDefined()
    expect(gate!.command).toBe('pnpm test:mcp-node')
    const script = rootPkg.scripts['test:mcp-node']
    expect(script).toContain('--project mcp-node')
    expect(script).not.toMatch(/mcp-jsdom|mcp-browser|web-browser/)
  })

  it('includes build, check:release-artifacts, smoke:tarball, smoke:packaged, generate:sbom:npm, smoke:distribution:packaged:node', () => {
    const ids = publishGates.map((g) => g.id)
    for (const expected of [
      'build',
      'check:release-artifacts',
      'smoke:tarball',
      'smoke:packaged',
      'generate:sbom:npm',
      'smoke:distribution:packaged:node',
    ]) {
      expect(ids, `publish tier must include gate "${expected}"`).toContain(expected)
    }
  })

  it('root test:mcp-node script exists and scopes to mcp-node only', () => {
    expect(rootPkg.scripts).toHaveProperty('test:mcp-node')
    expect(rootPkg.scripts['test:mcp-node']).toContain('--project mcp-node')
    expect(rootPkg.scripts['test:mcp-node']).not.toMatch(/mcp-jsdom|mcp-browser|web-browser/)
  })

  it('root smoke:distribution:packaged:node script exists', () => {
    expect(rootPkg.scripts).toHaveProperty('smoke:distribution:packaged:node')
  })
})

// The two matrix-driven runners are one implementation with two entry points.
// They were once hand-copied, and the copy drifted: one read the matrix without
// validating it. Every behavioural case below runs over BOTH entries, so a
// divergence in either fails here by name.
type Step = { label: string; command: string }
type FakeStatus = { status: number | null; error?: Error }
type Gate = { id: string; command: string; requiredFor: string[] }
type Sink = { write: (s: string) => boolean }
interface TierRunner {
  USAGE: string
  planSteps: (gates: Gate[]) => Step[]
  runSteps: (
    steps: Step[],
    opts: {
      cwd?: string
      spawn: (cmd: string, args: string[], o: unknown) => FakeStatus
      stdout?: Sink
      stderr?: Sink
    },
  ) => { ok: boolean; exitCode: number; ranLabels: string[] }
  parseArgs: (
    args: string[],
  ) => { mode: 'help' } | { mode: 'error'; message: string } | { mode: 'run' }
  main: (options?: {
    argv?: string[]
    repoRoot?: string
    readMatrix?: (matrixPath: string) => unknown
    spawn?: (cmd: string, args: string[], opts: unknown) => FakeStatus
    stdout?: Sink
    stderr?: Sink
  }) => number
}

const TIERS: readonly {
  script: string
  entry: string
  tier: string
  prerequisites: Step[]
}[] = [
  {
    script: 'publish-gate',
    entry: 'tools/checks/src/publish-gate.mjs',
    tier: 'publish',
    prerequisites: [],
  },
  {
    script: 'pages-release',
    entry: 'tools/checks/src/pages-release.mjs',
    tier: 'pages-release',
    prerequisites: [{ label: 'build', command: 'pnpm build' }],
  },
]

const SHARED_MODULE = 'tools/checks/src/release-gate-tier.mjs'

const sink = () => {
  const chunks: string[] = []
  return {
    write: (s: string) => {
      chunks.push(s)
      return true
    },
    chunks,
  }
}
const quiet: Sink = { write: () => true }

const loadRunner = async (entry: string): Promise<TierRunner> =>
  (await import(pathToFileURL(join(ROOT, entry)).href)) as TierRunner

const validGate = (tier: string) => ({
  id: 'a',
  command: 'pnpm a',
  category: 'unit',
  requiredFor: [tier],
  requiresDocker: false,
  requiresNetwork: false,
  expectedRuntimeBucket: 'fast',
})

describe('the matrix-driven runners share one implementation', () => {
  it('the loop, the matrix read and the validation live in the shared module only', () => {
    const shared = readText(SHARED_MODULE)
    expect(shared).toContain('release-gate-matrix.json')
    expect(shared).toContain('release-gate-matrix-schema.mjs')
    expect(shared).toContain('validateMatrix')
    for (const { entry } of TIERS) {
      const text = readText(entry)
      expect(text, `${entry} must not re-implement the loop`).not.toMatch(
        /function (runSteps|planSteps|parseArgs|main)\b/,
      )
      expect(text, `${entry} must not validate the matrix itself`).not.toContain('validateMatrix')
      expect(text.split('\n').length, `${entry} is an entry point, not a runner`).toBeLessThan(40)
    }
  })

  it('the package.json scripts name each entry point', () => {
    const pkg = readJson('tools/checks/package.json') as { scripts?: Record<string, string> }
    for (const { script, entry } of TIERS) {
      expect(pkg.scripts?.[script]).toBe(`node ${entry.replace('tools/checks/', '')}`)
    }
  })
})

describe.each(TIERS)('$script runner is matrix-driven', ({ script, entry, tier }) => {
  it('names its tier in the entry point', () => {
    expect(readText(entry)).toContain(`'${tier}'`)
  })

  it('root package.json delegates to @whiteboard/checks', () => {
    const wired = Object.values(rootPkg.scripts).filter(
      (v) => v === `pnpm --filter @whiteboard/checks ${script}`,
    )
    expect(wired).toHaveLength(1)
  })

  it('usage names its own script and tier', async () => {
    const { USAGE } = await loadRunner(entry)
    expect(USAGE).toContain(`@whiteboard/checks ${script}`)
    expect(USAGE).toContain(`"${tier}" tier`)
  })
})

// Behavioural coverage for the fail-loud invalid-matrix branch: a text grep
// only proves a runner mentions validateMatrix, not that an invalid matrix is
// rejected before any step runs. main() is injectable (readMatrix/spawn/
// stdout/stderr) so this runs without the real checkout or real processes.
describe.each(TIERS)('$script main() decides before it spawns anything', ({
  script,
  entry,
  tier,
  prerequisites,
}) => {
  it('exits non-zero and never spawns a step when the matrix fails validation', async () => {
    const { main } = await loadRunner(entry)
    const stderr = sink()
    const exitCode = main({
      readMatrix: () => ({ schemaVersion: 1, gates: [] }), // empty gates: fails validateMatrix
      spawn: () => {
        throw new Error('spawn must not be called for an invalid matrix')
      },
      stdout: quiet,
      stderr,
    })
    expect(exitCode).not.toBe(0)
    expect(stderr.chunks.join('')).toMatch(/invalid release-gate-matrix\.json/)
    expect(stderr.chunks.join('')).toContain(`[${script}]`)
  })

  it('runs the prerequisites then the tier gates and succeeds when the matrix is valid', async () => {
    const { main } = await loadRunner(entry)
    const calls: string[] = []
    const exitCode = main({
      readMatrix: () => ({ schemaVersion: 1, gates: [validGate(tier)] }),
      spawn: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`.trim())
        return { status: 0 }
      },
      stdout: quiet,
      stderr: quiet,
    })
    expect(exitCode).toBe(0)
    expect(calls).toEqual([...prerequisites.map((p) => p.command), 'pnpm a'])
  })

  it('fails loud instead of running only the prerequisites when no gate carries the tier', async () => {
    const { main } = await loadRunner(entry)
    const stderr = sink()
    const spawned: string[] = []
    const exitCode = main({
      readMatrix: () => ({
        schemaVersion: 1,
        gates: [validGate(tier === 'publish' ? 'pages-release' : 'publish')],
      }),
      spawn: (cmd) => {
        spawned.push(cmd)
        return { status: 0 }
      },
      stdout: quiet,
      stderr,
    })
    expect(exitCode).toBe(1)
    expect(spawned).toEqual([])
    expect(stderr.chunks.join('')).toContain(`no ${tier} gates found`)
  })

  it('prints usage and exits 0 on --help without reading the matrix', async () => {
    const { main, USAGE } = await loadRunner(entry)
    const stdout = sink()
    const exitCode = main({
      argv: ['--help'],
      readMatrix: () => {
        throw new Error('--help must not read the matrix')
      },
      stdout,
      stderr: quiet,
    })
    expect(exitCode).toBe(0)
    expect(stdout.chunks.join('')).toBe(USAGE)
  })
})

// Extending the matrix with the additive prCoverage/env fields (pillar A/C)
// must not change either runner's matrix-loading behavior — both only read
// id/command/requiredFor off each gate.
describe.each(TIERS)('$script tolerates additive matrix fields', ({
  entry,
  tier,
  prerequisites,
}) => {
  it('planSteps ignores unknown prCoverage/env fields on a gate', async () => {
    const { planSteps } = await loadRunner(entry)
    const gates = [
      {
        id: 'a',
        command: 'pnpm a',
        requiredFor: [tier],
        prCoverage: { kind: 'exception', reason: 'test fixture' },
        env: { WHITEBOARD_DEV: '1' },
      },
      { id: 'b', command: 'pnpm b', requiredFor: ['ci'] },
    ]
    expect(planSteps(gates)).toEqual([...prerequisites, { label: 'a', command: 'pnpm a' }])
  })
})

describe.each(TIERS)('$script core loop (planSteps / runSteps)', ({
  entry,
  tier,
  prerequisites,
}) => {
  it('planSteps returns the prerequisites then exactly the tier gates, in matrix order', async () => {
    const { planSteps } = await loadRunner(entry)
    const steps = planSteps([
      { id: 'a', command: 'pnpm a', requiredFor: [tier] },
      { id: 'b', command: 'pnpm b', requiredFor: ['ci'] },
      { id: 'c', command: 'pnpm c', requiredFor: [tier] },
    ])
    expect(steps).toEqual([
      ...prerequisites,
      { label: 'a', command: 'pnpm a' },
      { label: 'c', command: 'pnpm c' },
    ])
  })

  it('planSteps applied to the real matrix runs every gate tagged for the tier exactly once', async () => {
    const { planSteps } = await loadRunner(entry)
    const tierGates = matrix.gates.filter((g) => g.requiredFor.includes(tier))
    expect(tierGates.length).toBeGreaterThan(0)
    expect(planSteps(matrix.gates).map((s) => s.label)).toEqual([
      ...prerequisites.map((p) => p.label),
      ...tierGates.map((g) => g.id),
    ])
  })

  it('runSteps spawns every step in order when all succeed', async () => {
    const { runSteps } = await loadRunner(entry)
    const calls: string[] = []
    const r = runSteps(
      [
        { label: 'build', command: 'pnpm build' },
        { label: 'x', command: 'pnpm smoke:tarball' },
      ],
      {
        cwd: '/repo',
        spawn: (cmd, args) => {
          calls.push(`${cmd} ${args.join(' ')}`.trim())
          return { status: 0 }
        },
        stdout: quiet,
        stderr: quiet,
      },
    )
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['pnpm build', 'pnpm smoke:tarball'])
  })

  it('runSteps stops at the first non-zero exit (fail-fast)', async () => {
    const { runSteps } = await loadRunner(entry)
    const calls: string[] = []
    const r = runSteps(
      [
        { label: 'build', command: 'pnpm build' },
        { label: 'fails', command: 'pnpm boom' },
        { label: 'after', command: 'pnpm after' },
      ],
      {
        cwd: '/repo',
        spawn: (cmd, args) => {
          calls.push(`${cmd} ${args.join(' ')}`.trim())
          return { status: args[0] === 'boom' ? 2 : 0 }
        },
        stdout: quiet,
        stderr: quiet,
      },
    )
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(2)
    expect(calls).toEqual(['pnpm build', 'pnpm boom'])
    expect(r.ranLabels).toEqual(['build', 'fails'])
  })

  it('runSteps reports a step that could not start and stops', async () => {
    const { runSteps } = await loadRunner(entry)
    const stderr = sink()
    const r = runSteps([{ label: 'x', command: 'pnpm x' }], {
      spawn: () => ({ status: null, error: new Error('ENOENT') }),
      stdout: quiet,
      stderr,
    })
    expect(r).toEqual({ ok: false, exitCode: 1, ranLabels: ['x'] })
    expect(stderr.chunks.join('')).toContain('could not start: ENOENT')
  })

  it('runSteps rejects a shell-shaped command without spawning it', async () => {
    const { runSteps } = await loadRunner(entry)
    let spawned = false
    const r = runSteps([{ label: 'x', command: 'pnpm a && pnpm b' }], {
      spawn: () => {
        spawned = true
        return { status: 0 }
      },
      stdout: quiet,
      stderr: quiet,
    })
    expect(r).toEqual({ ok: false, exitCode: 1, ranLabels: [] })
    expect(spawned).toBe(false)
  })
})

describe.each(TIERS)('$script CLI arg parsing (parseArgs)', ({ entry }) => {
  it('treats -h and --help as a help request', async () => {
    const { parseArgs } = await loadRunner(entry)
    expect(parseArgs(['-h'])).toEqual({ mode: 'help' })
    expect(parseArgs(['--help'])).toEqual({ mode: 'help' })
  })

  it('rejects unexpected arguments instead of silently running the gates', async () => {
    const { parseArgs } = await loadRunner(entry)
    expect(parseArgs(['--bogus'])).toEqual({
      mode: 'error',
      message: 'unexpected argument(s): --bogus',
    })
  })

  it('runs the gates when invoked with no arguments', async () => {
    const { parseArgs } = await loadRunner(entry)
    expect(parseArgs([])).toEqual({ mode: 'run' })
  })
})

describe('smoke:distribution:packaged drift', () => {
  it('its node distribution smoke set matches the 7 node smokes in test:e2e:distribution:only', () => {
    const distScript = rootPkg.scripts['test:e2e:distribution:only'] ?? ''
    const packagedScript = rootPkg.scripts['smoke:distribution:packaged:node'] ?? ''
    const distNodeSmokes = (
      distScript.match(/node tests\/e2e\/distribution\/\S+\.mjs/g) ?? []
    ).sort()
    const packagedNodeSmokes = (
      packagedScript.match(/node tests\/e2e\/distribution\/\S+\.mjs/g) ?? []
    ).sort()
    expect(distNodeSmokes.length).toBeGreaterThan(0)
    expect(packagedNodeSmokes).toEqual(distNodeSmokes)
  })

  it('is the two CLI smokes plus the node set, and the node set carries neither', () => {
    const packagedScript = rootPkg.scripts['smoke:distribution:packaged'] ?? ''
    const nodeScript = rootPkg.scripts['smoke:distribution:packaged:node'] ?? ''
    expect(packagedScript).toContain('pnpm smoke:claude')
    expect(packagedScript).toContain('pnpm smoke:codex')
    expect(packagedScript).toContain('pnpm smoke:distribution:packaged:node')
    expect(nodeScript).not.toMatch(/smoke:(?:claude|codex)(?![\w:-])/)
  })
})

describe('docs/contributing/releasing.md documents the publishability/correctness boundary', () => {
  it('states that verify CI at the same tag SHA is the correctness authority', () => {
    const doc = readText('docs/contributing/releasing.md')
    expect(doc).toMatch(/verify CI/i)
    expect(doc).toMatch(/publishability/i)
  })
})
