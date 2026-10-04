// `.claude/scripts/stress-changed.mjs` is the local counterpart of CI's `stress-changed-tests` job,
// and it is only worth running while it stresses what the job stresses. A remembered copy of the
// job's file filter or repeat counts drifts silently: the script keeps reporting green for a run
// CI would fail, and a trusted local check that disagrees with CI is worse than none.
//
// So the script is compared with ci.yml instead of with a second hand-written list. Its `--dry-run`
// prints the plan it would execute, and each line of that plan is derived from the job's own text
// below. A change to the job's pathspec, repeat counts, vitest flags or leg partition fails here
// until the script follows.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

interface Step {
  name?: string
  run?: string
}
interface Job {
  strategy?: { matrix?: { include?: { projects?: string }[] } }
  steps?: Step[]
}

const JOB_ID = 'stress-changed-tests'

function stressJob(): Job {
  const workflow = parseYaml(
    readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8'),
  ) as {
    jobs?: Record<string, Job>
  }
  const job = workflow.jobs?.[JOB_ID]
  if (job === undefined) throw new Error(`ci.yml has no ${JOB_ID} job`)
  return job
}

function stepRun(job: Job, namePrefix: string): string {
  const step = job.steps?.find((candidate) => candidate.name?.startsWith(namePrefix))
  if (step?.run === undefined) throw new Error(`${JOB_ID} has no step named "${namePrefix}…"`)
  return step.run
}

/** The job's vitest invocation with what a local run does not share (the shard, the project and
 * the file list) replaced by placeholders, so only the flags are compared. */
function normalise(command: string): string {
  return command
    .replace(/ --shard=\$\{\{[^}]*\}\}\/\$\{\{[^}]*\}\}/, '')
    .replace(/--project ('[^']*'|\S+)/, '--project <project>')
    .replace(/\$\{\{ steps\.changed\.outputs\.files \}\}/, '<files>')
    .replace(/\s+/g, ' ')
    .trim()
}

function plan(): string[] {
  return execFileSync(
    process.execPath,
    ['.claude/scripts/stress-changed.mjs', '--dry-run', '--base=HEAD'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    },
  )
    .split('\n')
    .filter((line) => line.startsWith('plan '))
}

const planLine = (lines: string[], key: string): string => {
  const line = lines.find((candidate) => candidate.startsWith(`plan ${key}: `))
  if (line === undefined)
    throw new Error(`the script's plan has no "${key}" line:\n${lines.join('\n')}`)
  return line.slice(`plan ${key}: `.length)
}

describe('stress-changed.mjs follows the stress-changed-tests job', () => {
  const job = stressJob()
  const lines = plan()

  it('collects with the same pathspec', () => {
    const collect = stepRun(job, 'Collect changed test files')
    const pathspec = /git diff --name-only HEAD\^1 HEAD -- (.+?) \| while/.exec(collect)?.[1]
    expect(pathspec, 'the collect step no longer has the shape this test reads').toBeDefined()

    expect(planLine(lines, 'collect').split(' -- ')[1]).toBe(pathspec)
  })

  it('runs the fresh-process loop as many times as the job does, with the job flags', () => {
    const stress = stepRun(job, 'Stress changed test files')
    const iterations = /for i in ([\d ]+); do/.exec(stress)?.[1]?.trim().split(/\s+/)
    expect(iterations, 'the stress step no longer loops over a literal list').toBeDefined()
    const jobCommand = /pnpm exec vitest run .*/.exec(stress)?.[0]
    expect(jobCommand).toBeDefined()

    expect(planLine(lines, 'fresh-runs')).toBe(String(iterations?.length))
    for (const leg of ['browser', 'node']) {
      expect(normalise(planLine(lines, `${leg} fresh`))).toBe(normalise(jobCommand ?? ''))
    }
  })

  it('repeats in-process with the same count and flags', () => {
    const jobCommand = /pnpm exec vitest run .*/.exec(
      stepRun(job, 'Repeat changed tests in-process'),
    )?.[0]
    expect(jobCommand).toBeDefined()

    for (const leg of ['browser', 'node']) {
      expect(normalise(planLine(lines, `${leg} repeats`))).toBe(normalise(jobCommand ?? ''))
    }
  })

  it("covers exactly the job's project partition", () => {
    const jobProjects = [
      ...new Set((job.strategy?.matrix?.include ?? []).map((leg) => leg.projects)),
    ].sort()
    const scriptProjects = ['browser', 'node']
      .map((leg) =>
        /--project ('[^']*'|\S+)/.exec(planLine(lines, `${leg} fresh`))?.[1]?.replace(/'/g, ''),
      )
      .sort()

    expect(jobProjects.length, 'the matrix no longer lists its project patterns').toBeGreaterThan(0)
    expect(scriptProjects).toEqual(jobProjects)
  })
})
