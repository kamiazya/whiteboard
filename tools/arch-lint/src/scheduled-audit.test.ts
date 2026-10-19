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
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { extractWorkflowJobs } from './workflow-jobs.js'

const ROOT = REPO_ROOT
const AUDIT_WORKFLOW = '.github/workflows/audit.yml'
const RELEASE_WORKFLOW = '.github/workflows/release.yml'

// The second audit: the published package's own resolution, with npm and
// none of pnpm-workspace.yaml's overrides (tools/checks/src/audit-published.mjs).
// It is NOT the merge gate's command, so it is held apart from the
// byte-identical comparison below rather than allowed to break it.
const PUBLISHED_AUDIT = 'pnpm audit:published'

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
    .filter((run) => !run.startsWith(PUBLISHED_AUDIT))
}

async function stepsOf(workflowPath: string, jobId: string) {
  const job = (await jobsOf(workflowPath)).find((candidate) => candidate.id === jobId)
  if (job === undefined) throw new Error(`${workflowPath} has no \`${jobId}\` job`)
  return job.steps
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

// pnpm-lock.yaml carries the workspace's overrides and a consumer's install
// carries none, so the merge-gate audit can report a floor as cleared that
// `npx @kamiazya/whiteboard-mcp` never gets. The published audit is where
// that resolution is read; these pin that it actually runs.
describe('the published-resolution audit', () => {
  it('is a root script pointing at the published-audit runner', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['audit:published']).toBe('node tools/checks/src/audit-published.mjs')
  })

  it('runs on the schedule even when the merge-gate audit failed first', async () => {
    const steps = await stepsOf(AUDIT_WORKFLOW, 'audit')
    const published = steps.find((step) => step.run === PUBLISHED_AUDIT)
    expect(published, `${AUDIT_WORKFLOW} does not run \`${PUBLISHED_AUDIT}\``).toBeDefined()
    // A step after a failed one is skipped by default, so without this a
    // merge-gate finding would hide every consumer-side one behind it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
    expect(published?.if).toBe('${{ !cancelled() }}')
  })

  it('audits the packed release tarball before it is uploaded for publishing', async () => {
    const steps = await stepsOf(RELEASE_WORKFLOW, 'build-mcp')
    const pack = steps.findIndex((step) => step.name === 'Pack the tarball')
    const audit = steps.findIndex((step) => step.run === `${PUBLISHED_AUDIT} --tarball "$TARBALL"`)
    const upload = steps.findIndex((step) => step.name === 'Upload the tarball for publish-mcp')
    expect(pack, 'build-mcp has no `Pack the tarball` step').toBeGreaterThanOrEqual(0)
    expect(audit, `build-mcp does not run \`${PUBLISHED_AUDIT}\` on the tarball`).toBeGreaterThan(
      pack,
    )
    expect(upload).toBeGreaterThan(audit)
  })
})
