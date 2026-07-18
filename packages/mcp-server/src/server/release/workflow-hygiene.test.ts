// Standing workflow-hygiene policy, distinct from ci-workflow-steps.test.ts
// (which checks step/gate isomorphism): scans the RAW TEXT of every
// .github/workflows/*.yml for two structural regressions that a diff review
// can miss —
//   1. inline `node -e` / `python -c` style interpreters in a `run:` block
//      (production logic belongs in a versioned, unit-tested script)
//   2. an environment variable placed at job scope (ambient to every step)
//      when it is only needed by one step
// The raw-text scan is deliberate: ci-workflow-steps.mjs explicitly skips
// multi-line `run: |` blocks, so it cannot see an inline interpreter buried
// inside one.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github', 'workflows')
const RELEASE_WORKFLOW_PATH = resolve(WORKFLOWS_DIR, 'release.yml')
const SCANNER_MODULE = join(REPO_ROOT, 'tools/checks/src/env-scope-scanner.mjs')

async function importScanner() {
  const mod = await import(pathToFileURL(SCANNER_MODULE).href)
  return mod as {
    scanEnvKeyPlacements: (
      yamlText: string,
      key: string,
    ) => { jobLevel: { jobId: string }[]; stepLevel: { jobId: string; stepName: string }[] }
  }
}

// The full inline-interpreter class this repo has decided never belongs in
// a workflow `run:` block.
const INLINE_INTERPRETER_PATTERNS: RegExp[] = [
  /\bnode\s+-e\b/,
  /\bnode\s+--eval\b/,
  /\bnode\s+-p\b/,
  /\bnode\s+--print\b/,
  /\bpython\s+-c\b/,
  /\bpython3\s+-c\b/,
]

function findInlineInterpreterUsages(yamlText: string): string[] {
  return INLINE_INTERPRETER_PATTERNS.filter((rx) => rx.test(yamlText)).map((rx) => rx.source)
}

describe('workflow hygiene: no inline interpreters', () => {
  it('flags a fixture containing an inline `node -e`', () => {
    const fixture = 'jobs:\n  x:\n    steps:\n      - run: echo hi | node -e "console.log(1)"\n'
    expect(findInlineInterpreterUsages(fixture)).not.toEqual([])
  })

  it('does not flag a fixture that only calls a versioned script', () => {
    const fixture =
      'jobs:\n  x:\n    steps:\n      - run: node tools/checks/src/verify-pack-contents.mjs\n'
    expect(findInlineInterpreterUsages(fixture)).toEqual([])
  })

  const workflowFiles = readdirSync(WORKFLOWS_DIR).filter(
    (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
  )
  it('discovers at least one workflow file to scan', () => {
    expect(workflowFiles.length).toBeGreaterThan(0)
  })

  it.each(workflowFiles)('%s has zero inline interpreter usages', (file) => {
    const text = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf-8')
    expect(findInlineInterpreterUsages(text)).toEqual([])
  })
})

describe('workflow hygiene: WHITEBOARD_DEV is step-scoped, not job-scoped', () => {
  it('scanner fixture: flags a job-level placement', async () => {
    const { scanEnvKeyPlacements } = await importScanner()
    const fixture = [
      'jobs:',
      '  example:',
      '    env:',
      "      WHITEBOARD_DEV: '1'",
      '    steps:',
      '      - name: A step',
      '        run: echo hi',
      '',
    ].join('\n')
    const result = scanEnvKeyPlacements(fixture, 'WHITEBOARD_DEV')
    expect(result.jobLevel).toEqual([{ jobId: 'example' }])
    expect(result.stepLevel).toEqual([])
  })

  it('scanner fixture: an allow-listed step-level placement passes (no job-level hit)', async () => {
    const { scanEnvKeyPlacements } = await importScanner()
    const fixture = [
      'jobs:',
      '  example:',
      '    steps:',
      '      - name: Allowed step',
      '        env:',
      "          WHITEBOARD_DEV: '1'",
      '        run: echo hi',
      '',
    ].join('\n')
    const result = scanEnvKeyPlacements(fixture, 'WHITEBOARD_DEV')
    expect(result.jobLevel).toEqual([])
    expect(result.stepLevel).toEqual([{ jobId: 'example', stepName: 'Allowed step' }])
  })

  it('scanner fixture: does not drop later env keys when a comment is dedented inside the env block', async () => {
    const { scanEnvKeyPlacements } = await importScanner()
    const fixture = [
      'jobs:',
      '  example:',
      '    env:',
      '    # comment dedented to job-body indent, before some env keys',
      '      FOO: bar',
      "      WHITEBOARD_DEV: '1'",
      '    steps:',
      '      - name: A step',
      '        run: echo hi',
      '',
    ].join('\n')
    const result = scanEnvKeyPlacements(fixture, 'WHITEBOARD_DEV')
    expect(result.jobLevel).toEqual([{ jobId: 'example' }])
  })

  it('scanner fixture: reports a non-allow-listed step by name too', async () => {
    const { scanEnvKeyPlacements } = await importScanner()
    const fixture = [
      'jobs:',
      '  example:',
      '    steps:',
      '      - name: Unexpected step',
      '        env:',
      "          WHITEBOARD_DEV: '1'",
      '        run: echo hi',
      '',
    ].join('\n')
    const result = scanEnvKeyPlacements(fixture, 'WHITEBOARD_DEV')
    expect(result.stepLevel).toEqual([{ jobId: 'example', stepName: 'Unexpected step' }])
  })

  // Any job-level WHITEBOARD_DEV placement in release.yml is a regression:
  // it would silence the src-vs-dist daemon spawn switch (spawn-args.ts) for
  // every step in that job, not just the one that actually needs it.
  it('release.yml has zero job-level WHITEBOARD_DEV placements', async () => {
    const { scanEnvKeyPlacements } = await importScanner()
    const text = readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8')
    const result = scanEnvKeyPlacements(text, 'WHITEBOARD_DEV')
    expect(result.jobLevel).toEqual([])
  })

  // Non-allow-listed step names here signal a raw `env: { WHITEBOARD_DEV }`
  // reappearing on a step that no longer needs it (the C-item investigation
  // found no publish-tier or docker-tier consumer once `build` always
  // precedes the smokes in matrix order).
  const ALLOW_LISTED_STEPS: string[] = []
  it('release.yml has no step-level WHITEBOARD_DEV placements outside the allow-list', async () => {
    const { scanEnvKeyPlacements } = await importScanner()
    const text = readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8')
    const result = scanEnvKeyPlacements(text, 'WHITEBOARD_DEV')
    const unexpected = result.stepLevel.filter((hit) => !ALLOW_LISTED_STEPS.includes(hit.stepName))
    expect(unexpected).toEqual([])
  })
})
