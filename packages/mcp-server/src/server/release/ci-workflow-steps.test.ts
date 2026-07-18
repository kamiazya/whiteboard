// Unit coverage for the minimal GitHub Actions workflow step extractor
// (tools/checks/src/ci-workflow-steps.mjs) used by gate-isomorphism.test.ts to
// check that release-only gates are also exercised on pull requests.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')
const MODULE = join(ROOT, 'tools/checks/src/ci-workflow-steps.mjs')

async function importExtractor() {
  const mod = await import(pathToFileURL(MODULE).href)
  return mod as {
    extractWorkflowJobs: (yamlText: string) => Array<{
      id: string
      if: string | null
      steps: Array<{ name: string; run: string | null; if: string | null }>
    }>
  }
}

const FIXTURE = `name: fixture

on:
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc

      - name: Conditional step
        if: \${{ github.event_name == 'pull_request' }}
        run: pnpm check:pr-title

      # a comment between steps
      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

  guarded:
    if: \${{ github.ref == 'refs/heads/main' }}
    runs-on: ubuntu-latest
    steps:
      - name: Only on main
        run: pnpm publish
`

describe('extractWorkflowJobs', () => {
  it('extracts job ids in document order', async () => {
    const { extractWorkflowJobs } = await importExtractor()
    const jobs = extractWorkflowJobs(FIXTURE)
    expect(jobs.map((j) => j.id)).toEqual(['build', 'guarded'])
  })

  it('extracts step name, run command, and if-condition', async () => {
    const { extractWorkflowJobs } = await importExtractor()
    const jobs = extractWorkflowJobs(FIXTURE)
    const build = jobs.find((j) => j.id === 'build')!
    const typecheck = build.steps.find((s) => s.name === 'Typecheck')
    expect(typecheck?.run).toBe('pnpm typecheck')
    expect(typecheck?.if).toBeNull()
  })

  it('skips comment-only lines between steps without dropping later steps', async () => {
    const { extractWorkflowJobs } = await importExtractor()
    const jobs = extractWorkflowJobs(FIXTURE)
    const build = jobs.find((j) => j.id === 'build')!
    expect(build.steps.map((s) => s.name)).toContain('Install')
    expect(build.steps.map((s) => s.name)).toContain('Typecheck')
  })

  it('extracts a step-level if-condition', async () => {
    const { extractWorkflowJobs } = await importExtractor()
    const jobs = extractWorkflowJobs(FIXTURE)
    const build = jobs.find((j) => j.id === 'build')!
    const conditional = build.steps.find((s) => s.name === 'Conditional step')
    expect(conditional?.if).toBe(`\${{ github.event_name == 'pull_request' }}`)
  })

  it('extracts a job-level if-condition', async () => {
    const { extractWorkflowJobs } = await importExtractor()
    const jobs = extractWorkflowJobs(FIXTURE)
    const guarded = jobs.find((j) => j.id === 'guarded')!
    expect(guarded.if).toBe(`\${{ github.ref == 'refs/heads/main' }}`)
  })

  it('returns an empty array when there is no jobs: key', async () => {
    const { extractWorkflowJobs } = await importExtractor()
    expect(extractWorkflowJobs('name: x\non: push\n')).toEqual([])
  })

  it('does not drop later steps when a comment is dedented below the job body indent', async () => {
    const { extractWorkflowJobs } = await importExtractor()
    const fixture = [
      'jobs:',
      '  build:',
      '  # comment dedented to the job-id indent, before steps:',
      '    steps:',
      '      - name: Checkout',
      '        run: echo checkout',
      '      - name: Install',
      '        run: echo install',
      '',
    ].join('\n')
    const jobs = extractWorkflowJobs(fixture)
    const build = jobs.find((j) => j.id === 'build')!
    expect(build.steps.map((s) => s.name)).toEqual(['Checkout', 'Install'])
  })
})
