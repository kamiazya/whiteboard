// The aggregate gate is only as good as its `needs` list, and a forgotten
// entry is the silent kind of wrong: nothing goes red, a job simply stops
// being gated while the one required check stays green. That is what this
// file refuses.
//
// It also pins the two things that make the gate safe rather than merely
// convenient — `if: always()`, without which a failed dependency skips the
// gate and the required check never reports at all; and the per-job `skipped`
// allowlist, since a job that fails to start also reports `skipped`.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

interface WorkflowJob {
  id: string
  if: string | null
  needs: string[]
}

const { extractWorkflowJobs } = (await import(
  pathToFileURL(join(ROOT, 'tools/checks/src/ci-workflow-steps.mjs')).href
)) as { extractWorkflowJobs: (yaml: string) => WorkflowJob[] }

const { gateFailures, SKIPPABLE_JOBS } = (await import(
  pathToFileURL(join(ROOT, 'tools/checks/src/ci-gate.mjs')).href
)) as {
  gateFailures: (needs: unknown) => string[]
  SKIPPABLE_JOBS: Record<string, string>
}

const GATE_ID = 'ci-gate'
const jobs = extractWorkflowJobs(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8'))
const gate = jobs.find((job) => job.id === GATE_ID)

describe('ci.yml has one aggregate gate that covers every job', () => {
  it('parsed a plausible number of jobs', () => {
    // A scanner that stopped matching would report "nothing ungated" for an
    // empty set, which is the answer this file exists to distrust.
    expect(jobs.length).toBeGreaterThan(5)
    expect(jobs.map((job) => job.id)).toContain('test-jsdom')
  })

  it('declares the gate job', () => {
    expect(gate, `ci.yml must define a \`${GATE_ID}\` job`).toBeDefined()
  })

  it('runs the gate even when a dependency failed', () => {
    // Without always(), GitHub skips a job whose dependency failed, so the one
    // check branch protection waits on never reports and the merge blocks on
    // an absent check rather than on the real failure.
    expect(gate?.if).toBe('always()')
  })

  it('needs every other job in the workflow', () => {
    const ungated = jobs
      .map((job) => job.id)
      .filter((id) => id !== GATE_ID && !(gate?.needs ?? []).includes(id))
    expect(
      ungated,
      "these ci.yml jobs are not in ci-gate's `needs`, so the aggregate required check " +
        'stays green when they fail. Add them, or the gate is decoration.',
    ).toEqual([])
  })

  it('needs nothing that is not a job', () => {
    const ids = new Set(jobs.map((job) => job.id))
    const dangling = (gate?.needs ?? []).filter((id) => !ids.has(id))
    expect(dangling, 'ci-gate needs a job that ci.yml does not define').toEqual([])
  })
})

describe('the gate allows a skip only where the workflow can produce one', () => {
  it('names only real jobs', () => {
    const ids = new Set(jobs.map((job) => job.id))
    expect(Object.keys(SKIPPABLE_JOBS).filter((id) => !ids.has(id))).toEqual([])
  })

  it('names only jobs that actually carry a job-level condition', () => {
    // Guarded from this side too, so an entry cannot outlive the `if:` that
    // justifies it — otherwise the allowlist quietly becomes a blanket.
    const unconditional = Object.keys(SKIPPABLE_JOBS).filter(
      (id) => jobs.find((job) => job.id === id)?.if === null,
    )
    expect(
      unconditional,
      'these jobs have no job-level `if:`, so they cannot legitimately be skipped',
    ).toEqual([])
  })

  it('gives every entry a reason', () => {
    for (const [id, reason] of Object.entries(SKIPPABLE_JOBS)) {
      expect(reason.length, `${id} needs a reason, not a bare exemption`).toBeGreaterThan(20)
    }
  })
})

describe('the gate refuses everything but success', () => {
  const ok = { check: { result: 'success' }, 'test-jsdom': { result: 'success' } }

  it('passes when every job succeeded', () => {
    expect(gateFailures(ok)).toEqual([])
  })

  it('fails on a failed job', () => {
    expect(gateFailures({ ...ok, verify: { result: 'failure' } })).toEqual(['verify: failure'])
  })

  it('fails on a cancelled job', () => {
    expect(gateFailures({ ...ok, verify: { result: 'cancelled' } })).toEqual(['verify: cancelled'])
  })

  it('fails on a skip it was not told to expect', () => {
    // The one that matters: a job that fails to start reports `skipped`, so a
    // blanket allowance is a gate that passes when the workflow is broken.
    expect(gateFailures({ ...ok, verify: { result: 'skipped' } })).toHaveLength(1)
  })

  it('passes a skip that is declared', () => {
    const declared = Object.keys(SKIPPABLE_JOBS)[0] as string
    expect(gateFailures({ ...ok, [declared]: { result: 'skipped' } })).toEqual([])
  })

  it('fails on a payload that carried no results at all', () => {
    // "No problems found" over nothing reads exactly like a pass.
    expect(gateFailures({})).toHaveLength(1)
    expect(gateFailures(null)).toHaveLength(1)
    expect(gateFailures('{}')).toHaveLength(1)
  })

  it('fails on a job whose result key is missing', () => {
    expect(gateFailures({ ...ok, verify: {} })).toEqual(['verify: no result'])
  })
})
