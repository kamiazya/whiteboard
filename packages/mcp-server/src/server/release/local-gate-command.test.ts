// `pnpm check:local` must run everything CI's `check` job runs.
//
// The gap this closes is not hypothetical: the five commands a session
// habitually ran before pushing (`typecheck`, `lint`, `lint:noconsole`,
// `audit`, `knip`) were a remembered list, not a derived one, and CI's
// `check` job had grown three more (`intent:validate`, `secretlint`,
// `test:scripts`). A remembered list reports green while the job it is
// standing in for would fail — which is worse than having no local command,
// because it is trusted.
//
// So the command is checked against ci.yml rather than against a second
// hand-written list. A step added to the `check` job fails this test until
// `check:local` runs it too.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

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

// Setup, not a gate: restoring the workspace is what a developer's checkout
// already is. Everything else in the job is something that can fail.
const NOT_A_GATE = new Set(['pnpm install --frozen-lockfile'])

// The one step taken from `verify` rather than `check`. `verify` otherwise
// builds, packs and smokes the published artifacts — minutes of work that
// belongs in CI — while knip is seconds and catches the dead export a
// refactor leaves behind, which is exactly what a local pre-push pass is
// for. Listed explicitly so the borrowing is a decision on the record.
const BORROWED_FROM_VERIFY = ['pnpm knip']

async function checkJobCommands(): Promise<string[]> {
  const { extractWorkflowJobs } = (await import(
    pathToFileURL(join(ROOT, 'tools/checks/src/ci-workflow-steps.mjs')).href
  )) as { extractWorkflowJobs: (yamlText: string) => WorkflowJob[] }
  const jobs = extractWorkflowJobs(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8'))
  const check = jobs.find((job) => job.id === 'check')
  if (check === undefined) throw new Error('ci.yml has no `check` job')
  return check.steps
    .map((step) => step.run)
    .filter((run): run is string => run?.startsWith('pnpm '))
    .filter((run) => !NOT_A_GATE.has(run))
}

function localGateCommand(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>
  }
  const script = pkg.scripts['check:local']
  if (script === undefined) throw new Error('package.json has no `check:local` script')
  return script
}

describe('pnpm check:local', () => {
  it("runs every gate CI's check job runs", async () => {
    const commands = await checkJobCommands()
    const script = localGateCommand()
    const missing = commands.filter((command) => !script.includes(command))

    expect(
      missing,
      "CI's check job gained a gate that `pnpm check:local` does not run. Add it " +
        'to the script — a local pass that reports green while CI would fail is ' +
        'worse than no local pass, because it gets trusted.',
    ).toEqual([])
  })

  // Without this the extractor silently matching nothing — a renamed job, a
  // `run: |` block it does not parse — would make the assertion above pass
  // against an empty list.
  it('finds the gates it is comparing against', async () => {
    const commands = await checkJobCommands()

    expect(commands.length).toBeGreaterThanOrEqual(5)
    expect(commands).toContain('pnpm lint')
    expect(commands).toContain('pnpm typecheck')
  })

  it('also runs the cheap gates borrowed from the verify job', () => {
    const script = localGateCommand()
    const missing = BORROWED_FROM_VERIFY.filter((command) => !script.includes(command))

    expect(missing).toEqual([])
  })
})
