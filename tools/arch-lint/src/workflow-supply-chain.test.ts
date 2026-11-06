// Supply-chain invariants every workflow is held to, repository-wide. Each one
// is a control in docs/contributing/security-baseline.md, named beside it:
//
//   - a workflow states its token at the root, and the root grants no write
//     (OpenSSF Scorecard Token-Permissions; OSPS Baseline OSPS-AC-04.01/.02).
//     A job with no `permissions:` of its own inherits the root, so a root that
//     says nothing hands the next job added the repository default — which on
//     an older repository is read-write to everything.
//   - every third-party action is pinned to a full commit SHA
//     (Scorecard Pinned-Dependencies). release.yml and the setup-pnpm action
//     had this guard alone; a tag on any other workflow was invisible to it.
//   - the Scorecard and dependency-review workflows exist, and keep the shape
//     their consumers require: the Scorecard API rejects published results
//     from a workflow that breaks its restrictions, and a dependency review
//     that only comments blocks nothing (OSPS-VM-05.03).

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

type Permissions = string | Record<string, string> | undefined

interface Step {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}
interface Job {
  'runs-on'?: string
  permissions?: Permissions
  env?: unknown
  defaults?: unknown
  container?: unknown
  services?: unknown
  steps?: Step[]
}
interface Workflow {
  on?: Record<string, unknown> | string | string[]
  permissions?: Permissions
  env?: unknown
  defaults?: unknown
  jobs?: Record<string, Job>
}

const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows')
const ACTIONS_DIR = join(REPO_ROOT, '.github/actions')
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))
const readWorkflow = (file: string): Workflow =>
  parseYaml(readFileSync(join(WORKFLOWS_DIR, file), 'utf-8')) as Workflow
/** A workflow that may be absent: its describe then fails on `exists`, not at collection. */
const readOptionalWorkflow = (file: string): Workflow =>
  existsSync(join(WORKFLOWS_DIR, file)) ? readWorkflow(file) : {}
const hasOwn = (value: unknown, key: string): boolean =>
  typeof value === 'object' && value !== null && Object.hasOwn(value, key)

/** Every scope a permissions value grants write on, `write-all` included. */
function writeScopes(permissions: Permissions): string[] {
  if (permissions === undefined) return []
  if (typeof permissions === 'string') return permissions === 'write-all' ? ['*'] : []
  return Object.entries(permissions)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => scope)
}

/** The `uses:` values of a workflow or composite action, local actions excluded. */
function externalUses(yamlText: string): string[] {
  const doc = parseYaml(yamlText) as {
    jobs?: Record<string, { uses?: string; steps?: Step[] }>
    runs?: { steps?: Step[] }
  }
  const jobUses = Object.values(doc.jobs ?? {}).flatMap((job) => [
    ...(job.uses === undefined ? [] : [job.uses]),
    ...(job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
  ])
  const compositeUses = (doc.runs?.steps ?? []).flatMap((step) =>
    step.uses === undefined ? [] : [step.uses],
  )
  return [...jobUses, ...compositeUses].filter((ref) => !ref.startsWith('./'))
}

/** A `uses:` reference that names something mutable. */
function unpinnedReason(ref: string): string | null {
  if (ref.startsWith('docker://')) {
    return /@sha256:[0-9a-f]{64}$/.test(ref) ? null : `${ref}: image not pinned by digest`
  }
  const at = ref.lastIndexOf('@')
  if (at <= 0) return `${ref}: no @ref at all`
  return COMMIT_SHA_RE.test(ref.slice(at + 1)) ? null : `${ref}: not a 40-char commit SHA`
}

describe('workflows — the token is stated at the root and grants no write there', () => {
  it('discovers every workflow', () => {
    expect(workflowFiles.length).toBeGreaterThan(10)
  })

  it('reads write scopes from a map and from the shorthand', () => {
    expect(writeScopes('write-all')).toEqual(['*'])
    expect(writeScopes('read-all')).toEqual([])
    expect(writeScopes({})).toEqual([])
    expect(writeScopes({ contents: 'read', deployments: 'write' })).toEqual(['deployments'])
  })

  it.each(workflowFiles)('%s declares a workflow-level permissions block', (file) => {
    expect(
      hasOwn(readWorkflow(file), 'permissions'),
      `${file} has no root permissions: every job without its own inherits the repository default`,
    ).toBe(true)
  })

  it.each(workflowFiles)('%s grants no write at the workflow root', (file) => {
    expect(
      writeScopes(readWorkflow(file).permissions),
      `${file}: move the write to the one job that needs it`,
    ).toEqual([])
  })
})

describe('workflows and composite actions — every third-party action is SHA-pinned', () => {
  const actionFiles = readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('.github/actions', entry.name, 'action.yml'))
  const sources = [
    ...workflowFiles.map((file) => join('.github/workflows', file)),
    ...actionFiles,
  ].map((path) => [path, externalUses(readFileSync(join(REPO_ROOT, path), 'utf-8'))] as const)

  it('classifies tags, branches, SHAs and docker references', () => {
    expect(unpinnedReason('actions/checkout@v4')).not.toBeNull()
    expect(unpinnedReason('actions/checkout@main')).not.toBeNull()
    expect(unpinnedReason('actions/checkout')).not.toBeNull()
    expect(unpinnedReason(`actions/checkout@${'a'.repeat(40)}`)).toBeNull()
    expect(unpinnedReason(`github/codeql-action/upload-sarif@${'b'.repeat(40)}`)).toBeNull()
    expect(unpinnedReason('docker://alpine:3')).not.toBeNull()
    expect(unpinnedReason(`docker://alpine@sha256:${'c'.repeat(64)}`)).toBeNull()
  })

  it('finds the actions the workflows use', () => {
    expect(sources.flatMap(([, refs]) => refs).length).toBeGreaterThan(50)
  })

  it.each(sources)('%s pins every action it uses', (_path, refs) => {
    expect(refs.map(unpinnedReason).filter((reason) => reason !== null)).toEqual([])
  })
})

describe('scorecard.yml — publishes OpenSSF Scorecard results the API accepts', () => {
  const workflow = readOptionalWorkflow('scorecard.yml')
  const jobs = Object.entries(workflow.jobs ?? {})
  const scorecardJobs = jobs.filter(([, job]) =>
    (job.steps ?? []).some((step) => (step.uses ?? '').startsWith('ossf/scorecard-action@')),
  )
  // The publishing API refuses results whose job ran any step outside this
  // list, since a step in the same job could have altered them.
  const APPROVED_STEP_ACTIONS = [
    'actions/checkout@',
    'actions/upload-artifact@',
    'github/codeql-action/upload-sarif@',
    'ossf/scorecard-action@',
    'step-security/harden-runner@',
  ]

  it('exists', () => {
    expect(existsSync(join(WORKFLOWS_DIR, 'scorecard.yml'))).toBe(true)
  })

  it('runs on the default branch, weekly, and when branch protection changes', () => {
    const on = (workflow.on ?? {}) as Record<string, { branches?: string[] } | null>
    expect(on.push?.branches).toEqual(['main'])
    expect(on.schedule).toBeDefined()
    expect(Object.hasOwn(on, 'branch_protection_rule')).toBe(true)
  })

  it('carries no workflow-level env or defaults', () => {
    expect(workflow.env).toBeUndefined()
    expect(workflow.defaults).toBeUndefined()
  })

  it('has exactly one Scorecard job, and it alone holds id-token: write', () => {
    expect(scorecardJobs).toHaveLength(1)
    const withIdToken = jobs
      .filter(([, job]) => writeScopes(job.permissions).includes('id-token'))
      .map(([id]) => id)
    expect(withIdToken).toEqual(scorecardJobs.map(([id]) => id))
  })

  it('publishes results and uploads SARIF to code scanning', () => {
    const [, job] = scorecardJobs[0] ?? ['', {}]
    const steps = job.steps ?? []
    const scan = steps.find((step) => (step.uses ?? '').startsWith('ossf/scorecard-action@'))
    expect(scan?.with?.publish_results).toBe(true)
    expect(scan?.with?.results_format).toBe('sarif')
    expect(
      steps.some((step) => (step.uses ?? '').startsWith('github/codeql-action/upload-sarif@')),
    ).toBe(true)
    expect(writeScopes(job.permissions).sort()).toEqual(['id-token', 'security-events'])
  })

  it('runs only approved actions, on a hosted Ubuntu runner, with no env or containers', () => {
    const [, job] = scorecardJobs[0] ?? ['', {}]
    expect(job.steps?.length ?? 0).toBeGreaterThan(0)
    for (const step of job.steps ?? []) {
      expect(step.run, `${step.name ?? '?'}: a run step makes the API refuse the results`).toBe(
        undefined,
      )
      expect(APPROVED_STEP_ACTIONS.some((prefix) => (step.uses ?? '').startsWith(prefix))).toBe(
        true,
      )
    }
    expect(job['runs-on']).toMatch(/^ubuntu-\d/)
    expect([job.env, job.defaults, job.container, job.services]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('checks out without keeping the job token', () => {
    const [, job] = scorecardJobs[0] ?? ['', {}]
    const checkout = (job.steps ?? []).find((step) =>
      (step.uses ?? '').startsWith('actions/checkout@'),
    )
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })
})
