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
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

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

  it('includes build, check:release-artifacts, smoke:tarball, smoke:packaged, generate:sbom:npm, smoke:distribution:packaged', () => {
    const ids = publishGates.map((g) => g.id)
    for (const expected of [
      'build',
      'check:release-artifacts',
      'smoke:tarball',
      'smoke:packaged',
      'generate:sbom:npm',
      'smoke:distribution:packaged',
    ]) {
      expect(ids, `publish tier must include gate "${expected}"`).toContain(expected)
    }
  })

  it('root test:mcp-node script exists and scopes to mcp-node only', () => {
    expect(rootPkg.scripts).toHaveProperty('test:mcp-node')
    expect(rootPkg.scripts['test:mcp-node']).toContain('--project mcp-node')
    expect(rootPkg.scripts['test:mcp-node']).not.toMatch(/mcp-jsdom|mcp-browser|web-browser/)
  })

  it('root smoke:distribution:packaged script exists', () => {
    expect(rootPkg.scripts).toHaveProperty('smoke:distribution:packaged')
  })
})

describe('publish-gate runner is matrix-driven', () => {
  it('reads release-gate-matrix.json instead of hardcoding gate commands', () => {
    const runner = readText('tools/checks/src/publish-gate.mjs')
    expect(runner).toContain('release-gate-matrix.json')
    expect(runner).toContain("'publish'")
  })

  it('@whiteboard/checks exposes a publish-gate script', () => {
    const pkg = readJson('tools/checks/package.json') as { scripts?: Record<string, string> }
    expect(pkg.scripts?.['publish-gate']).toBeTruthy()
  })

  it('root package.json wires a publish-gate script delegating to @whiteboard/checks', () => {
    expect(rootPkg.scripts['publish-gate']).toBe('pnpm --filter @whiteboard/checks publish-gate')
  })

  it('validates the matrix at load time via the shared schema validator, loud on invalid', () => {
    const runner = readText('tools/checks/src/publish-gate.mjs')
    expect(runner).toContain('release-gate-matrix-schema.mjs')
    expect(runner).toContain('validateMatrix')
  })
})

// Behavioral coverage for the fail-loud invalid-matrix branch: the text-grep
// assertions above only prove the runner mentions validateMatrix, not that an
// actually-invalid matrix is rejected before any step runs. main() is
// injectable (readMatrix/spawn/stdout/stderr) specifically so this can be
// exercised without touching the real repo checkout or spawning processes.
describe('publish-gate runner main() rejects an invalid matrix before running any step', () => {
  const importRunner = async () => {
    const mod = await import(pathToFileURL(join(ROOT, 'tools/checks/src/publish-gate.mjs')).href)
    return mod as {
      main: (options?: {
        argv?: string[]
        repoRoot?: string
        readMatrix?: (matrixPath: string) => unknown
        spawn?: (
          cmd: string,
          args: string[],
          opts: unknown,
        ) => { status: number | null; error?: Error }
        stdout?: { write: (s: string) => boolean }
        stderr?: { write: (s: string) => boolean }
      }) => number
    }
  }
  const sink = () => {
    const chunks: string[] = []
    return { write: (s: string) => (chunks.push(s), true), chunks }
  }

  it('exits non-zero and never spawns a step when the matrix fails validation', async () => {
    const { main } = await importRunner()
    const stdout = sink()
    const stderr = sink()
    const spawn = () => {
      throw new Error('spawn must not be called for an invalid matrix')
    }
    const exitCode = main({
      readMatrix: () => ({ schemaVersion: 1, gates: [] }), // empty gates: fails validateMatrix
      spawn,
      stdout,
      stderr,
    })
    expect(exitCode).not.toBe(0)
    expect(stderr.chunks.join('')).toMatch(/invalid release-gate-matrix\.json/)
  })

  it('runs the publish-tier steps and succeeds when the matrix is valid', async () => {
    const { main } = await importRunner()
    const stdout = sink()
    const stderr = sink()
    const calls: string[] = []
    const spawn = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`.trim())
      return { status: 0 }
    }
    const exitCode = main({
      readMatrix: () => ({
        schemaVersion: 1,
        gates: [
          {
            id: 'a',
            command: 'pnpm a',
            category: 'unit',
            requiredFor: ['publish'],
            requiresDocker: false,
            requiresNetwork: false,
            expectedRuntimeBucket: 'fast',
          },
        ],
      }),
      spawn,
      stdout,
      stderr,
    })
    expect(exitCode).toBe(0)
    expect(calls).toEqual(['pnpm a'])
  })
})

// Extending the matrix with the additive prCoverage/env fields (pillar A/C)
// must not change publish-gate.mjs's or pages-release.mjs's matrix-loading
// behavior — both consumers only read id/command/requiredFor off each gate.
describe('publish-gate and pages-release tolerate additive matrix fields', () => {
  const extendedGates = [
    {
      id: 'a',
      command: 'pnpm a',
      requiredFor: ['publish'],
      prCoverage: { kind: 'exception', reason: 'test fixture' },
      env: { WHITEBOARD_DEV: '1' },
    },
    { id: 'b', command: 'pnpm b', requiredFor: ['pages-release'] },
  ]

  it('publish-gate.mjs planSteps ignores unknown prCoverage/env fields on a gate', async () => {
    const mod = (await import(
      pathToFileURL(join(ROOT, 'tools/checks/src/publish-gate.mjs')).href
    )) as { planSteps: (gates: typeof extendedGates) => { label: string; command: string }[] }
    expect(mod.planSteps(extendedGates)).toEqual([{ label: 'a', command: 'pnpm a' }])
  })

  it('pages-release.mjs planSteps ignores unknown prCoverage/env fields on a gate', async () => {
    const mod = (await import(
      pathToFileURL(join(ROOT, 'tools/checks/src/pages-release.mjs')).href
    )) as { planSteps: (gates: typeof extendedGates) => { label: string; command: string }[] }
    expect(mod.planSteps(extendedGates)).toEqual([
      { label: 'build', command: 'pnpm build' },
      { label: 'b', command: 'pnpm b' },
    ])
  })
})

describe('publish-gate runner core loop (planSteps / runSteps)', () => {
  type Step = { label: string; command: string }
  type FakeStatus = { status: number | null; error?: Error }
  const sink = { write: (_: string) => true }

  const importRunner = async () => {
    const mod = await import(pathToFileURL(join(ROOT, 'tools/checks/src/publish-gate.mjs')).href)
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

  it('planSteps returns exactly the publish-tier gates, in matrix order', async () => {
    const { planSteps } = await importRunner()
    const steps = planSteps([
      { id: 'a', command: 'pnpm a', requiredFor: ['publish'] },
      { id: 'b', command: 'pnpm b', requiredFor: ['ci'] },
      { id: 'c', command: 'pnpm c', requiredFor: ['publish'] },
    ])
    expect(steps).toEqual([
      { label: 'a', command: 'pnpm a' },
      { label: 'c', command: 'pnpm c' },
    ])
  })

  it('planSteps applied to the real matrix runs every gate tagged requiredFor:publish exactly once', async () => {
    const { planSteps } = await importRunner()
    const steps = planSteps(matrix.gates)
    expect(steps.map((s) => s.label)).toEqual(publishGates.map((g) => g.id))
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
        { label: 'x', command: 'pnpm smoke:tarball' },
      ],
      { cwd: '/repo', spawn, stdout: sink, stderr: sink },
    )
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['pnpm build', 'pnpm smoke:tarball'])
  })

  it('runSteps stops at the first non-zero exit (fail-fast)', async () => {
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
    expect(calls).toEqual(['pnpm build', 'pnpm boom'])
    expect(r.ranLabels).toEqual(['build', 'fails'])
  })
})

// pages-release.mjs mirrors publish-gate.mjs's matrix-driven shape, but until
// now it read the matrix straight off disk and passed it to planSteps without
// validating it via the shared schema authority — a malformed pages-release
// gate would only surface as a runtime failure deep in an unrelated step
// (or wouldn't surface at all), instead of the loud, immediate rejection
// publish-gate.mjs gives the same class of problem.
describe('pages-release runner main() rejects an invalid matrix before running any step', () => {
  const importRunner = async () => {
    const mod = await import(pathToFileURL(join(ROOT, 'tools/checks/src/pages-release.mjs')).href)
    return mod as {
      main: (options?: {
        argv?: string[]
        repoRoot?: string
        readMatrix?: (matrixPath: string) => unknown
        spawn?: (
          cmd: string,
          args: string[],
          opts: unknown,
        ) => { status: number | null; error?: Error }
        stdout?: { write: (s: string) => boolean }
        stderr?: { write: (s: string) => boolean }
      }) => number
    }
  }
  const sink = () => {
    const chunks: string[] = []
    return { write: (s: string) => (chunks.push(s), true), chunks }
  }

  it('exits non-zero and never spawns a step when the matrix fails validation', async () => {
    const { main } = await importRunner()
    const stdout = sink()
    const stderr = sink()
    const spawn = () => {
      throw new Error('spawn must not be called for an invalid matrix')
    }
    const exitCode = main({
      readMatrix: () => ({ schemaVersion: 1, gates: [] }), // empty gates: fails validateMatrix
      spawn,
      stdout,
      stderr,
    })
    expect(exitCode).not.toBe(0)
    expect(stderr.chunks.join('')).toMatch(/invalid release-gate-matrix\.json/)
  })

  it('runs pnpm build then the pages-release gates and succeeds when the matrix is valid', async () => {
    const { main } = await importRunner()
    const stdout = sink()
    const stderr = sink()
    const calls: string[] = []
    const spawn = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`.trim())
      return { status: 0 }
    }
    const exitCode = main({
      readMatrix: () => ({
        schemaVersion: 1,
        gates: [
          {
            id: 'a',
            command: 'pnpm a',
            category: 'pages',
            requiredFor: ['pages-release'],
            requiresDocker: false,
            requiresNetwork: false,
            expectedRuntimeBucket: 'fast',
          },
        ],
      }),
      spawn,
      stdout,
      stderr,
    })
    expect(exitCode).toBe(0)
    expect(calls).toEqual(['pnpm build', 'pnpm a'])
  })
})

describe('publish-gate runner CLI arg parsing (parseArgs)', () => {
  const importRunner = async () => {
    const mod = await import(pathToFileURL(join(ROOT, 'tools/checks/src/publish-gate.mjs')).href)
    return mod as {
      parseArgs: (
        args: string[],
      ) => { mode: 'help' } | { mode: 'error'; message: string } | { mode: 'run' }
    }
  }

  it('treats -h as a help request', async () => {
    const { parseArgs } = await importRunner()
    expect(parseArgs(['-h'])).toEqual({ mode: 'help' })
  })

  it('treats --help as a help request', async () => {
    const { parseArgs } = await importRunner()
    expect(parseArgs(['--help'])).toEqual({ mode: 'help' })
  })

  it('rejects unexpected arguments instead of silently running the gates', async () => {
    const { parseArgs } = await importRunner()
    expect(parseArgs(['--bogus'])).toEqual({
      mode: 'error',
      message: 'unexpected argument(s): --bogus',
    })
  })

  it('runs the gates when invoked with no arguments', async () => {
    const { parseArgs } = await importRunner()
    expect(parseArgs([])).toEqual({ mode: 'run' })
  })
})

describe('smoke:distribution:packaged drift', () => {
  it('its node distribution smoke set matches the 7 node smokes in test:e2e:distribution', () => {
    const distScript = rootPkg.scripts['test:e2e:distribution'] ?? ''
    const packagedScript = rootPkg.scripts['smoke:distribution:packaged'] ?? ''
    const distNodeSmokes = (
      distScript.match(/node tests\/e2e\/distribution\/\S+\.mjs/g) ?? []
    ).sort()
    const packagedNodeSmokes = (
      packagedScript.match(/node tests\/e2e\/distribution\/\S+\.mjs/g) ?? []
    ).sort()
    expect(distNodeSmokes.length).toBeGreaterThan(0)
    expect(packagedNodeSmokes).toEqual(distNodeSmokes)
  })

  it('includes smoke:claude and smoke:codex', () => {
    const packagedScript = rootPkg.scripts['smoke:distribution:packaged'] ?? ''
    expect(packagedScript).toContain('pnpm smoke:claude')
    expect(packagedScript).toContain('pnpm smoke:codex')
  })
})

describe('docs/contributing/releasing.md documents the publishability/correctness boundary', () => {
  it('states that verify CI at the same tag SHA is the correctness authority', () => {
    const doc = readText('docs/contributing/releasing.md')
    expect(doc).toMatch(/verify CI/i)
    expect(doc).toMatch(/publishability/i)
  })
})
