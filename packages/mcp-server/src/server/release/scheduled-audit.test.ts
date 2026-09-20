// The scheduled audit must stay the SAME command CI's merge gate runs.
//
// The gap it closes is a measurement, not a hypothesis: `pnpm audit:prod`
// queries the live advisory database, so an advisory published against an
// unchanged dependency tree turns every open branch red at once, and until
// 2026-09-19 nothing looked for that except the next person to push. The
// scheduled run makes the bump somebody's scheduled work instead.
//
// A watcher that runs a DIFFERENT command is worse than none, because it
// reports green over a gate it never exercised — the same failure shape
// local-gate-command.test.ts exists for, one workflow over.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractWorkflowJobs } from './workflow-jobs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')
const AUDIT_WORKFLOW = '.github/workflows/audit.yml'

interface WorkflowStep {
  name: string
  run: string | null
  if: string | null
}
interface WorkflowJob {
  id: string
  if: string | null
  steps: WorkflowStep[]
}

async function jobsOf(workflowPath: string): Promise<WorkflowJob[]> {
  return extractWorkflowJobs(readFileSync(join(ROOT, workflowPath), 'utf-8'))
}

/** Every `pnpm audit…` command a workflow's named job runs, as written. */
async function auditCommandsIn(workflowPath: string, jobId: string): Promise<string[]> {
  const job = (await jobsOf(workflowPath)).find((candidate) => candidate.id === jobId)
  if (job === undefined) throw new Error(`${workflowPath} has no \`${jobId}\` job`)
  return job.steps
    .map((step) => step.run)
    .filter((run): run is string => run?.startsWith('pnpm audit') === true)
}

describe('the scheduled audit', () => {
  it('runs the same command the merge gate runs', async () => {
    const gated = await auditCommandsIn('.github/workflows/ci.yml', 'check')

    expect(gated, "ci.yml's check job no longer runs an audit").toHaveLength(1)
    expect(
      await auditCommandsIn(AUDIT_WORKFLOW, 'audit'),
      `${AUDIT_WORKFLOW} must run exactly what the merge gate runs, or it reports ` +
        'green over a gate it never exercised',
    ).toEqual(gated)
  })

  it('is on a schedule, and can also be run by hand', () => {
    const text = readFileSync(join(ROOT, AUDIT_WORKFLOW), 'utf-8')

    // Daily, at a non-zero MINUTE: GitHub queues on-the-hour schedules
    // behind every other repository's, so `0 2 * * *` is the one shape a
    // reviewer would let through and should not. The bound is written out
    // rather than `\d{1,2}` — that admits `0` and made this assertion
    // unfailable, which a mutation check caught.
    expect(text).toMatch(/^\s*- cron: '(?:[1-9]|[1-5]\d) \d{1,2} \* \* \*'$/m)
    expect(text).toContain('workflow_dispatch:')
  })

  // Without this, a regex that stopped matching would report "the two agree"
  // over two empty lists.
  it('finds the command it is comparing', async () => {
    expect(await auditCommandsIn(AUDIT_WORKFLOW, 'audit')).toEqual(['pnpm audit:prod'])
    expect(await auditCommandsIn('.github/workflows/ci.yml', 'check')).toEqual(['pnpm audit:prod'])
  })
})
