// ci.yml's two Rust jobs and rust-fuzz-nightly.yml, held to the scripts and
// crates they run. Each fact here is written twice — once where a tool or a
// gate is defined, once in the workflow — and nothing else notices when the
// copies part:
//
//   - a tool version the workflow installs that the script then refuses
//     ("cargo-deny 0.20.2 is required, found 0.21.0") fails the job, but a
//     version bumped in the script and not in the workflow fails only in CI,
//     after the push;
//   - a gate step dropped from the `rust` job leaves it green having checked
//     less, which reads exactly like a pass;
//   - RUSTFLAGS anywhere in the job's environment REPLACES every other source
//     of rustflags, so the size ledger and the reproducibility check would
//     measure a build that does not ship;
//   - actions/cache keys an entry by its path list too, so a PR job restoring
//     the nightly corpus under a different list restores nothing, silently.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, unknown>
  with?: Record<string, unknown>
}
interface Job {
  env?: Record<string, unknown>
  steps?: Step[]
}
interface Workflow {
  env?: Record<string, unknown>
  jobs: Record<string, Job>
}

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf-8')
const ci = parseYaml(read('.github/workflows/ci.yml')) as Workflow
const nightly = parseYaml(read('.github/workflows/rust-fuzz-nightly.yml')) as Workflow

const RUST_JOBS = ['rust', 'rust-fuzz-pr']
const stepsOf = (workflow: Workflow, id: string): Step[] => workflow.jobs[id]?.steps ?? []
const runs = (workflow: Workflow, id: string): string[] =>
  stepsOf(workflow, id).flatMap((step) => (step.run === undefined ? [] : [step.run]))

/** The version a source file pins, read by a pattern that must match once. */
function pinned(path: string, pattern: RegExp): string {
  const match = read(path).match(pattern)
  if (match?.[1] === undefined) throw new Error(`${path} no longer matches ${pattern}`)
  return match[1]
}

/** Each tool the Rust jobs install, and where the code that refuses a wrong one pins it. */
const TOOL_PINS: Record<string, string> = {
  'cargo-deny': pinned('tools/checks/src/rust-check.mjs', /cargo-deny --version (\S+?)'/),
  'wasm-bindgen': pinned('Cargo.toml', /^wasm-bindgen = "=([^"]+)"/m),
  'cargo-auditable': pinned('crates/xtask/src/dist.rs', /cargo-auditable --version (\S+?)"/),
  'cargo-about': pinned('crates/xtask/src/notices.rs', /const ABOUT_VERSION: &str = "([^"]+)"/),
  'cargo-llvm-cov': pinned(
    'crates/xtask/src/coverage.rs',
    /const LLVM_COV_VERSION: &str = "([^"]+)"/,
  ),
}
const FUZZ_PIN = pinned('tools/checks/src/rust-fuzz.mjs', /cargo-fuzz --version (\S+?)'/)

describe('the rust job runs every Rust gate', () => {
  it.each([
    'pnpm rust:check',
    'pnpm rust:build:wasm',
    'pnpm exec vitest run --project=canvas-render-rust',
    'pnpm --filter @kamiazya/whiteboard-core-wasm stage:wasm',
    'pnpm --filter @kamiazya/whiteboard-core-wasm typecheck:abi',
    'pnpm exec vitest run --project=core-wasm-rust',
    'pnpm rust:release:check',
  ])('runs %s, gated on its own scope', (command) => {
    const step = stepsOf(ci, 'rust').find((s) => s.run?.trim() === command)
    expect(step, `no step of the rust job runs \`${command}\``).toBeDefined()
    expect(step?.if).toBe("steps.scope.outputs.run == 'true'")
  })

  it('runs the PR fuzz script on a pull request and every target on any other event', () => {
    const script = runs(ci, 'rust-fuzz-pr').join('\n')
    expect(script).toMatch(/^\s*pnpm rust:fuzz:pr\s*$/m)
    expect(script).toMatch(/^\s*pnpm rust:fuzz:pr --all\s*$/m)
    const step = stepsOf(ci, 'rust-fuzz-pr').find((s) => s.run?.includes('rust:fuzz:pr'))
    // The merge commit's first parent: what the change is diffed against.
    expect(step?.env?.RUST_FUZZ_BASE).toBe('HEAD^1')
  })
})

describe('the Rust jobs install the tool versions the scripts require', () => {
  const installs = stepsOf(ci, 'rust').filter((s) => s.uses?.startsWith('taiki-e/install-action@'))
  const tools = Object.fromEntries(
    installs
      .flatMap((s) => String(s.with?.tool ?? '').split(','))
      .map((spec) => spec.trim().split('@') as [string, string]),
  )

  it('installs through one pinned step that may not fall back to another source', () => {
    expect(installs).toHaveLength(1)
    expect(installs[0]?.with?.fallback).toBe('none')
  })

  it.each(Object.entries(TOOL_PINS))('installs %s at %s', (tool, version) => {
    expect(tools[tool], `the rust job installs ${tool} at another version`).toBe(version)
  })

  it('installs no tool the scripts do not pin', () => {
    expect(Object.keys(tools).sort()).toEqual(Object.keys(TOOL_PINS).sort())
  })

  it.each([
    ['ci.yml rust-fuzz-pr', runs(ci, 'rust-fuzz-pr')],
    ['rust-fuzz-nightly.yml fuzz', runs(nightly, 'fuzz')],
  ])('%s installs cargo-fuzz at the version rust-fuzz.mjs names', (_where, scripts) => {
    const versions = [...scripts.join('\n').matchAll(/cargo-fuzz --version (\S+)/g)].map(
      (m) => m[1],
    )
    expect(versions.length).toBeGreaterThan(0)
    expect(new Set(versions)).toEqual(new Set([FUZZ_PIN]))
  })
})

describe('no Rust job sets RUSTFLAGS', () => {
  it.each(RUST_JOBS)('%s', (id) => {
    const envs = [ci.env, ci.jobs[id]?.env, ...stepsOf(ci, id).map((s) => s.env)]
    expect(stepsOf(ci, id).length).toBeGreaterThan(3)
    for (const env of envs) expect(Object.keys(env ?? {})).not.toContain('RUSTFLAGS')
    expect(runs(ci, id).join('\n')).not.toMatch(/\bRUSTFLAGS=/)
  })
})

describe('the PR fuzz job restores the cache entry the nightly saves', () => {
  const cacheStep = (workflow: Workflow, id: string): Step | undefined =>
    stepsOf(workflow, id).find((s) => /^actions\/cache(\/restore)?@/.test(s.uses ?? ''))
  const lines = (value: unknown): string[] =>
    String(value ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort()
  const saved = cacheStep(nightly, 'fuzz')
  const restored = cacheStep(ci, 'rust-fuzz-pr')

  it('restores without saving, so a pull request cannot write the corpus', () => {
    expect(restored?.uses).toMatch(/^actions\/cache\/restore@/)
    expect(saved?.uses).toMatch(/^actions\/cache@/)
  })

  it('restores the same path list, which is part of the cache key', () => {
    expect(lines(saved?.with?.path).length).toBeGreaterThan(1)
    expect(lines(restored?.with?.path)).toEqual(lines(saved?.with?.path))
  })

  it("reads the nightly's key prefix, and the same actions/cache release", () => {
    const prefix = String(saved?.with?.['restore-keys'] ?? '').trim()
    expect(prefix).not.toBe('')
    expect(String(saved?.with?.key)).toMatch(new RegExp(`^${prefix}`))
    expect(String(restored?.with?.['restore-keys']).trim()).toBe(prefix)
    const sha = (uses: string | undefined) => uses?.slice(uses.lastIndexOf('@') + 1)
    expect(sha(restored?.uses)).toBe(sha(saved?.uses))
  })
})

describe('the core-wasm action builds what the rust job builds', () => {
  const action = parseYaml(read('.github/actions/core-wasm/action.yml')) as {
    runs: { steps: Step[] }
  }
  const steps = action.runs.steps
  const keyStep = steps.find((s) => s.name === 'Core wasm cache key')
  const inputs = String(keyStep?.env?.INPUTS ?? '')

  it('installs wasm-bindgen at the version the crate pins, and names it in the key', () => {
    const install = steps.find((s) => s.uses?.startsWith('taiki-e/install-action@'))
    expect(install?.with?.tool).toBe(`wasm-bindgen@${TOOL_PINS['wasm-bindgen']}`)
    expect(install?.with?.fallback).toBe('none')
    expect(keyStep?.run).toContain(`wasm-bindgen-${TOOL_PINS['wasm-bindgen']}-`)
  })

  it.each([
    'crates/**',
    'Cargo.lock',
    'Cargo.toml',
    '.cargo/**',
    'rust-toolchain.toml',
    'tools/checks/src/rust-build-wasm.mjs',
    'packages/core-wasm/scripts/stage-artifacts.mjs',
  ])('keys the cache on %s, an input of the artifact', (path) => {
    expect(inputs).toContain(`'${path}'`)
  })

  it('builds through build:wasm, the path the size ledger measures, and saves under the key it restored', () => {
    expect(
      steps.some(
        (s) => s.run?.trim() === 'pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm',
      ),
    ).toBe(true)
    const restore = steps.find((s) => s.uses?.startsWith('actions/cache/restore@'))
    const save = steps.find((s) => s.uses?.startsWith('actions/cache/save@'))
    expect(save?.with).toEqual(restore?.with)
    expect(restore?.with?.path).toBe('packages/core-wasm/artifacts')
  })

  it('is restored by the stress lane before it reruns a changed node test', () => {
    const stress = stepsOf(ci, 'stress-changed-tests')
    const at = stress.findIndex((s) => s.uses === './.github/actions/core-wasm')
    const run = stress.findIndex((s) => s.name?.startsWith('Stress changed test files'))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(run)
  })

  it('is what test-unit restores before mcp-node runs in differential', () => {
    const unit = stepsOf(ci, 'test-unit')
    const at = unit.findIndex((s) => s.uses === './.github/actions/core-wasm')
    const test = unit.findIndex((s) => s.run?.includes('--project=mcp-node'))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(test)
    expect(unit[test]?.env).toEqual({
      WHITEBOARD_CORE: 'differential',
      WHITEBOARD_CORE_MISMATCH: 'throw',
    })
  })

  it('is what test-browser restores before the browser projects run in differential', () => {
    const browser = stepsOf(ci, 'test-browser')
    const at = browser.findIndex((s) => s.uses === './.github/actions/core-wasm')
    const test = browser.findIndex((s) => s.run?.includes('run test-browser'))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(test)
    // Restored when the browser projects run at all, never only when a
    // narrower scope happens to name the web app.
    expect(browser[at]?.if).toBe("steps.scope.outputs.run == 'true'")
    expect(browser[test]?.env).toMatchObject({
      VITE_WHITEBOARD_CORE: 'differential',
      VITE_WHITEBOARD_CORE_MISMATCH: 'throw',
    })
  })

  it('is restored for every stress leg, and turned on for the browser leg alone', () => {
    const stress = stepsOf(ci, 'stress-changed-tests')
    const restore = stress.find((s) => s.uses === './.github/actions/core-wasm')
    expect(restore?.if).toBe("steps.changed.outputs.files != ''")
    const runs = stress.filter((s) => s.run?.includes('pnpm exec vitest run'))
    expect(runs).toHaveLength(2)
    for (const run of runs) {
      // The whole expression: the browser leg compares and fails, the node leg is unset.
      expect(run.env?.VITE_WHITEBOARD_CORE).toMatch(
        /^\$\{\{ matrix\.leg == 'browser' && 'differential' \|\| '' \}\}$/,
      )
      expect(run.env?.VITE_WHITEBOARD_CORE_MISMATCH).toMatch(
        /^\$\{\{ matrix\.leg == 'browser' && 'throw' \|\| '' \}\}$/,
      )
    }
  })

  it('is not needed by test-jsdom, whose pages cannot fetch the wasm', () => {
    const jsdom = stepsOf(ci, 'test-jsdom')
    expect(jsdom.some((s) => s.uses === './.github/actions/core-wasm')).toBe(false)
    expect(jsdom.some((s) => JSON.stringify(s.env ?? {}).includes('VITE_WHITEBOARD_CORE'))).toBe(
      false,
    )
  })
})
