import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

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

describe('release.yml — permissions are granted per job, never at the root', () => {
  // A workflow-level `permissions` block is ambient to every job that does not
  // override it, and a job-level block REPLACES it rather than adding to it —
  // so a root grant is read by exactly the jobs that declare nothing, which is
  // the set nobody is looking at. This workflow pushes tags, publishes to npm
  // under OIDC and pushes a signed image, so the root is where a write costs
  // the most and is seen the least.
  //
  // The pair below is deliberately two conditions, not one: dropping the root
  // block is only an improvement while every job still says what it needs, and
  // a later job added with no block would otherwise inherit the repository
  // default silently.
  async function releaseWorkflow(): Promise<{
    permissions?: unknown
    jobs: Record<string, { permissions?: Record<string, string> }>
  }> {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8')
    return parseYaml(text)
  }

  it('grants no permission at the workflow root', async () => {
    const workflow = await releaseWorkflow()
    expect(
      workflow.permissions,
      'release.yml declares workflow-level permissions — move the grant to the job that needs it',
    ).toBeUndefined()
  })

  it('has every job declare its own permissions', async () => {
    const workflow = await releaseWorkflow()
    const jobIds = Object.keys(workflow.jobs)
    expect(jobIds.length, 'no jobs parsed — the check would pass vacuously').toBeGreaterThan(1)
    const undeclared = jobIds.filter((id) => workflow.jobs[id].permissions === undefined)
    expect(
      undeclared,
      'these jobs inherit the repository default instead of saying what they need',
    ).toEqual([])
  })

  it('scopes packages: write to docker-publish-sign alone', async () => {
    const workflow = await releaseWorkflow()
    const withPackagesWrite = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.packages === 'write')
      .map(([id]) => id)
    expect(withPackagesWrite).toEqual(['docker-publish-sign'])
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
 * however many times anyone presses the button. Measured: four
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

describe('release.yml — either publish half can be retried alone', () => {
  // `publish-mcp` fails on a version npm already has, and `docker-publish-sign`
  // does not wait on it. A dispatch that forced both therefore made retrying a
  // failed image push also run a known-failing npm publish, which lands a red
  // job where the release watch reports "no later success retired it". Each job
  // gates on its own input, so the retry of one never schedules the other.
  interface ReleaseWorkflow {
    on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } }
    jobs: Record<string, { if?: string }>
  }

  async function releaseWorkflow(): Promise<ReleaseWorkflow> {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8')
    return parseYaml(text)
  }

  interface Dispatch {
    releaseCreated: string
    tag: string | null
    publishNpm: boolean | null
    publishDocker: boolean | null
  }

  /**
   * Evaluates a job's `if:` against one event. GitHub's `&&` / `||` / `==` / `!=`
   * on these operands mean what they mean in JS, so the expression is read as
   * JS once every context reference has been replaced by a literal. A reference
   * this map does not know throws, so a gate that starts reading a new input
   * fails here by name rather than being evaluated as if it were absent.
   */
  function jobRuns(expression: string, event: Dispatch): boolean {
    const values: Record<string, unknown> = {
      'needs.release-please.outputs.mcp_release_created': event.releaseCreated,
      'inputs.force_publish_tag': event.tag,
      'inputs.publish_npm': event.publishNpm,
      'inputs.publish_docker': event.publishDocker,
    }
    const js = expression
      .replace(/^\s*\$\{\{|\}\}\s*$/g, '')
      .replace(/(?:needs\.release-please\.outputs|inputs)\.\w+/g, (reference) => {
        if (!(reference in values)) throw new Error(`unmodelled reference ${reference}`)
        return JSON.stringify(values[reference])
      })
    return Boolean(new Function(`return (${js})`)())
  }

  const TAG = 'mcp-server-v0.0.20'

  it('declares both retry switches as booleans that default to on', async () => {
    const { inputs } = (await releaseWorkflow()).on.workflow_dispatch
    for (const name of ['publish_npm', 'publish_docker']) {
      expect(inputs[name]?.type, `${name} input`).toBe('boolean')
      expect(inputs[name]?.default, `${name} default`).toBe(true)
    }
  })

  it('runs only the npm half when a dispatch switches the image off', async () => {
    const { jobs } = await releaseWorkflow()
    const event: Dispatch = { releaseCreated: '', tag: TAG, publishNpm: true, publishDocker: false }

    expect(jobRuns(jobs['publish-mcp']?.if ?? '', event)).toBe(true)
    expect(jobRuns(jobs['docker-publish-sign']?.if ?? '', event)).toBe(false)
  })

  it('runs only the image half when a dispatch switches npm off', async () => {
    const { jobs } = await releaseWorkflow()
    const event: Dispatch = { releaseCreated: '', tag: TAG, publishNpm: false, publishDocker: true }

    expect(jobRuns(jobs['publish-mcp']?.if ?? '', event)).toBe(false)
    expect(jobRuns(jobs['docker-publish-sign']?.if ?? '', event)).toBe(true)
  })

  it('runs neither half on a dispatch that names no tag', async () => {
    const { jobs } = await releaseWorkflow()
    const event: Dispatch = { releaseCreated: '', tag: '', publishNpm: true, publishDocker: true }

    expect(jobRuns(jobs['publish-mcp']?.if ?? '', event)).toBe(false)
    expect(jobRuns(jobs['docker-publish-sign']?.if ?? '', event)).toBe(false)
  })

  // A push carries no inputs at all, so the switches read as null there and a
  // release-please release must still publish both halves.
  it('runs both halves when release-please created the release', async () => {
    const { jobs } = await releaseWorkflow()
    const event: Dispatch = {
      releaseCreated: 'true',
      tag: null,
      publishNpm: null,
      publishDocker: null,
    }

    expect(jobRuns(jobs['publish-mcp']?.if ?? '', event)).toBe(true)
    expect(jobRuns(jobs['docker-publish-sign']?.if ?? '', event)).toBe(true)
  })
})
