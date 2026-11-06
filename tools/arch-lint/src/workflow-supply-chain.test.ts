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

import { readdirSync, readFileSync } from 'node:fs'
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
