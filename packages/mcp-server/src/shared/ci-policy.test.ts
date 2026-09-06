import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../')

// A full 40-character hex commit SHA — the only form that is immutable.
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

describe('release.yml — action pinning policy', () => {
  it('every uses: entry is pinned to a 40-char commit SHA (no mutable tags)', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8')

    // Extract all `uses: owner/repo@ref` values. Local composite actions
    // (relative paths starting with "./") are excluded: they are not external
    // supply-chain dependencies — the checked-out commit itself already pins
    // their contents, so there is no separate ref to SHA-pin.
    const usesRefs = [...text.matchAll(/uses:\s+(\S+)/g)]
      .map((m) => m[1])
      .filter((ref) => !ref.startsWith('./'))
    expect(usesRefs.length).toBeGreaterThan(0)

    for (const ref of usesRefs) {
      const at = ref.lastIndexOf('@')
      expect(at, `${ref}: missing @ separator`).toBeGreaterThan(0)
      const sha = ref.slice(at + 1)
      expect(
        COMMIT_SHA_RE.test(sha),
        `Action ${ref} uses mutable ref "${sha}" — pin to a 40-char commit SHA`,
      ).toBe(true)
    }
  })
})

describe('setup-pnpm composite action — pinning policy', () => {
  it('every uses: entry is pinned to a 40-char commit SHA (no mutable tags)', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/actions/setup-pnpm/action.yml'), 'utf-8')

    const usesRefs = [...text.matchAll(/uses:\s+(\S+)/g)].map((m) => m[1])
    expect(usesRefs.length).toBeGreaterThan(0)

    for (const ref of usesRefs) {
      const at = ref.lastIndexOf('@')
      expect(at, `${ref}: missing @ separator`).toBeGreaterThan(0)
      const sha = ref.slice(at + 1)
      expect(
        COMMIT_SHA_RE.test(sha),
        `Action ${ref} uses mutable ref "${sha}" — pin to a 40-char commit SHA`,
      ).toBe(true)
    }
  })
})

describe('release.yml — root permissions policy', () => {
  it('packages: write is absent from the workflow root permissions block', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8')

    // Everything before `jobs:` is the workflow preamble (root-level keys).
    // `packages: write` with 2-space indent is a root-level permissions entry.
    const preamble = text.split(/^jobs:/m)[0] ?? text
    expect(
      preamble,
      'packages: write found at workflow root — it must be scoped to docker-publish-sign job only',
    ).not.toMatch(/^ {2}packages:\s+write/m)
  })
})

describe('ci.yml — biome lint gate', () => {
  it('runs pnpm lint (full biome check) in the check job', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8')
    expect(
      text,
      'ci.yml must run pnpm lint so all biome rules (including noConsole overrides) are enforced in CI',
    ).toMatch(/run:\s+pnpm lint/)
  })

  it('biome.json enforces noConsole on server runtime code via overrides', async () => {
    const biome = JSON.parse(await readFile(join(REPO_ROOT, 'biome.json'), 'utf-8')) as {
      overrides?: Array<{
        includes?: string[]
        linter?: { rules?: { suspicious?: { noConsole?: string } } }
      }>
    }
    const serverOverride = biome.overrides?.find((o) =>
      o.includes?.some((p) => p.includes('packages/mcp-server/src/server')),
    )
    expect(serverOverride, 'biome.json must have a server-scoped noConsole override').toBeDefined()
    expect(serverOverride?.linter?.rules?.suspicious?.noConsole).toBe('error')
  })
})

/**
 * A sharded job's legs must not cancel each other.
 *
 * GitHub's matrix default is `fail-fast: true`, so one shard failing cancels
 * its siblings — and a `cancelled` job is unrecoverable through the UI's
 * "Re-run failed jobs", which re-runs `failure` only. The cancelled leg is
 * then carried into every later attempt with its original `started_at`,
 * `ci-gate` reads its real conclusion and refuses, and the PR cannot go green
 * however many times anyone presses the button. Measured on PR #1448: four
 * attempts, `test-unit (1)` carrying `started_at=10:47:20Z` through all of
 * them, never re-run once.
 *
 * The cost of `fail-fast: false` is runner minutes on a genuine failure —
 * the siblings run to the end instead of being cut short. That is the price
 * of a re-runnable red, and it is the cheaper half: the alternative charges
 * a full re-run of every job in the workflow.
 */
describe('ci.yml — a sharded job must be re-runnable after one leg fails', () => {
  it('declares fail-fast: false on every matrix, so a failing shard cannot cancel its siblings', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8')
    const workflow = parseYaml(text) as {
      jobs?: Record<string, { strategy?: { matrix?: unknown; 'fail-fast'?: boolean } }>
    }

    const sharded = Object.entries(workflow.jobs ?? {}).filter(
      ([, job]) => job.strategy?.matrix !== undefined,
    )
    // A count beside the walk, so a parse that stops finding matrices reads
    // as a broken scan rather than as a clean bill of health.
    expect(sharded.length).toBeGreaterThanOrEqual(3)

    // Reported together so a failure names WHICH jobs are unguarded rather
    // than stopping at the first.
    const cancellable = sharded
      .filter(([, job]) => job.strategy?.['fail-fast'] !== false)
      .map(([name]) => name)
    expect(cancellable).toEqual([])
  })
})
