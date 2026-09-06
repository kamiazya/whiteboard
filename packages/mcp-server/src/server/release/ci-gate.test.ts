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

interface RunJob {
  name: string
  status: string
  conclusion: string | null
}

const { gateFailures, SKIPPABLE_JOBS, baseJobName } = (await import(
  pathToFileURL(join(ROOT, 'tools/checks/src/ci-gate.mjs')).href
)) as {
  gateFailures: (input: { jobs: unknown; needed: string[]; gateJobName: string }) => string[]
  SKIPPABLE_JOBS: Record<string, string>
  baseJobName: (name: string) => string
}

function fixture(which: 'red' | 'green'): RunJob[] {
  return JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', `ci-run-jobs-${which}.json`), 'utf-8'),
  ) as RunJob[]
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

describe('the gate judges the run, and refuses everything but success', () => {
  const needed = () => gate?.needs ?? []
  const run = (jobs: unknown) => gateFailures({ jobs, needed: needed(), gateJobName: 'ci-gate' })

  it('reads a leg back to the job it belongs to', () => {
    expect(baseJobName('test-jsdom (1)')).toBe('test-jsdom')
    expect(baseJobName('verify')).toBe('verify')
  })

  it('passes a real green run of this workflow', () => {
    // Captured from an actual run, so the fixture cannot drift into a shape
    // the gate happens to like.
    expect(run(fixture('green'))).toEqual([])
  })

  it('fails a real red run of this workflow', () => {
    // The same capture from the run whose dry-run-docker job really failed.
    // This is what settles the question the `needs` form could not: the gate
    // sees per-leg conclusions, so whether a matrix job's single `needs`
    // result turns to `failure` never arises.
    expect(run(fixture('red'))).toEqual(['dry-run-docker: failure'])
  })

  it('ignores its own job, which is still running when it looks', () => {
    const jobs = fixture('green').map((job) =>
      job.name === 'ci-gate' ? { ...job, status: 'in_progress', conclusion: null } : job,
    )
    expect(run(jobs)).toEqual([])
  })

  it('fails a job that had not finished', () => {
    const jobs = fixture('green').map((job) =>
      job.name === 'verify' ? { ...job, status: 'in_progress', conclusion: null } : job,
    )
    expect(run(jobs)).toEqual(['verify: still in_progress when the gate ran'])
  })

  it('fails a cancelled job', () => {
    const jobs = fixture('green').map((job) =>
      job.name === 'verify' ? { ...job, conclusion: 'cancelled' } : job,
    )
    expect(run(jobs)).toEqual(['verify: cancelled'])
  })

  it('fails a skip it was not told to expect', () => {
    // The one that matters: a job that fails to start reports `skipped`, so a
    // blanket allowance is a gate that passes when the workflow is broken.
    const jobs = fixture('green').map((job) =>
      job.name === 'verify' ? { ...job, conclusion: 'skipped' } : job,
    )
    expect(run(jobs)).toHaveLength(1)
  })

  it('passes a skip that is declared, including on a leg', () => {
    const declared = Object.keys(SKIPPABLE_JOBS)[0] as string
    const jobs = fixture('green').map((job) =>
      baseJobName(job.name) === declared ? { ...job, conclusion: 'skipped' } : job,
    )
    expect(run(jobs)).toEqual([])
  })

  it('fails when a declared job is missing from the run entirely', () => {
    // A job that silently stopped running would otherwise leave the gate green
    // over a shrinking set.
    const jobs = fixture('green').filter((job) => baseJobName(job.name) !== 'verify')
    expect(run(jobs)).toEqual(['verify: declared in `needs` but absent from the run'])
  })

  it('fails on a run list that carried nothing to check', () => {
    // "No problems found" over nothing reads exactly like a pass.
    expect(run([])).toHaveLength(1)
    expect(run([{ name: 'ci-gate', status: 'in_progress', conclusion: null }])).toHaveLength(1)
    expect(run(null)).toHaveLength(1)
    expect(run('[]')).toHaveLength(1)
  })
})
