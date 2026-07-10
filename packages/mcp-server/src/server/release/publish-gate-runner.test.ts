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
