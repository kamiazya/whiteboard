// Gate isomorphism: every release-only gate (requiredFor includes 'publish' or
// 'docker-release') must have a declared, structurally-verified prCoverage so
// it is also exercised on pull requests. This is the pillar-A guard against
// the failure mode that caused the v0.0.7-v0.0.18 outage: a step that only
// ran on the release tag drifted out of sync with the rest of the pipeline
// for weeks before its first (and only) execution finally caught it.
//
// prCoverage.kind:
//  - 'workflow-step': the exact gate command must run as a named step inside
//    a specific ci.yml job, and neither the job nor the step may be gated
//    behind an `if:` outside the pinned always-true-on-PR allowlist below.
//  - 'aggregate': a coarser claim — the named ci.yml job exists and is
//    PR-reachable. (Full recursive package.json-script expansion with cycle
//    detection is a known simplification deferred to a follow-up; see the
//    tmp/issues note filed alongside this PR.)
//  - 'exception': a reasoned, pinned-allowlist opt-out (docker gates only).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf-8'))
}

function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf-8')
}

interface PrCoverage {
  kind: 'workflow-step' | 'aggregate' | 'exception'
  workflow?: string
  jobId?: string
  stepName?: string
  reason?: string
}

interface ReleaseGate {
  id: string
  command: string
  requiredFor: string[]
  requiresDocker: boolean
  prCoverage?: PrCoverage
}

interface GateMatrix {
  gates: ReleaseGate[]
}

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

// Forms of `if:` that are true on a normal pull-request run and therefore do
// not break PR reachability. Anything else must be treated as potentially
// removing the covering step from PR execution.
const ALWAYS_TRUE_ON_PR_IF = new Set([`\${{ github.event_name == 'pull_request' }}`])

async function loadExtractor() {
  const mod = await import(pathToFileURL(join(ROOT, 'tools/checks/src/ci-workflow-steps.mjs')).href)
  return mod as { extractWorkflowJobs: (yamlText: string) => WorkflowJob[] }
}

async function loadSchema() {
  const mod = await import(
    pathToFileURL(join(ROOT, 'tools/checks/src/release-gate-matrix-schema.mjs')).href
  )
  return mod as { validateMatrix: (m: unknown) => { ok: boolean; reason?: string } }
}

const matrix = readJson('tests/e2e/distribution/release-gate-matrix.json') as GateMatrix
const ciYaml = readText('.github/workflows/ci.yml')

// Deliberate, reviewed allowlist. Growing this set is a real test edit, not a
// silent config change — that friction is the point.
const EXCEPTION_ALLOWLIST = new Set(['smoke:docker', 'smoke:docker-backup-restore'])

function isJobPrReachable(job: WorkflowJob): boolean {
  return job.if === null || ALWAYS_TRUE_ON_PR_IF.has(job.if)
}

function isStepPrReachable(step: WorkflowStep): boolean {
  return step.if === null || ALWAYS_TRUE_ON_PR_IF.has(step.if)
}

function releaseOnlyGates(gates: ReleaseGate[]): ReleaseGate[] {
  return gates.filter(
    (g) => g.requiredFor.includes('publish') || g.requiredFor.includes('docker-release'),
  )
}

describe('release-gate-matrix.json is a valid matrix (schema authority)', () => {
  it('passes the shared validator', async () => {
    const { validateMatrix } = await loadSchema()
    const result = validateMatrix(matrix)
    expect(result.ok, result.reason).toBe(true)
  })
})

describe('every release-only gate declares prCoverage', () => {
  it('has no publish/docker-release gate missing a prCoverage declaration', () => {
    const missing = releaseOnlyGates(matrix.gates)
      .filter((g) => !g.prCoverage)
      .map((g) => g.id)
    expect(missing).toEqual([])
  })
})

describe('gate isomorphism: workflow-step coverage resolves structurally', () => {
  it('every workflow-step prCoverage points at an existing, PR-reachable ci.yml step', async () => {
    const { extractWorkflowJobs } = await loadExtractor()
    const jobs = extractWorkflowJobs(ciYaml)
    for (const gate of releaseOnlyGates(matrix.gates)) {
      const coverage = gate.prCoverage
      if (coverage?.kind !== 'workflow-step') continue
      const job = jobs.find((j) => j.id === coverage.jobId)
      expect(job, `gate "${gate.id}": job "${coverage.jobId}" not found in ci.yml`).toBeDefined()
      expect(
        isJobPrReachable(job!),
        `gate "${gate.id}": job "${coverage.jobId}" has a non-pinned if: "${job!.if}"`,
      ).toBe(true)
      const step = job!.steps.find((s) => s.name === coverage.stepName)
      expect(
        step,
        `gate "${gate.id}": step "${coverage.stepName}" not found in job "${coverage.jobId}"`,
      ).toBeDefined()
      expect(
        isStepPrReachable(step!),
        `gate "${gate.id}": step "${coverage.stepName}" has a non-pinned if: "${step!.if}"`,
      ).toBe(true)
      expect(
        step!.run,
        `gate "${gate.id}": step "${coverage.stepName}" must run the gate's exact command`,
      ).toBe(gate.command)
    }
  })
})

describe('gate isomorphism: aggregate coverage resolves to a PR-reachable job', () => {
  it('every aggregate prCoverage points at an existing, PR-reachable ci.yml job', async () => {
    const { extractWorkflowJobs } = await loadExtractor()
    const jobs = extractWorkflowJobs(ciYaml)
    for (const gate of releaseOnlyGates(matrix.gates)) {
      const coverage = gate.prCoverage
      if (coverage?.kind !== 'aggregate') continue
      const job = jobs.find((j) => j.id === coverage.jobId)
      expect(job, `gate "${gate.id}": job "${coverage.jobId}" not found in ci.yml`).toBeDefined()
      expect(
        isJobPrReachable(job!),
        `gate "${gate.id}": job "${coverage.jobId}" has a non-pinned if: "${job!.if}"`,
      ).toBe(true)
    }
  })
})

describe('gate isomorphism: exceptions are explicit and pinned', () => {
  it('every exception has a non-empty reason', () => {
    for (const gate of releaseOnlyGates(matrix.gates)) {
      if (gate.prCoverage?.kind !== 'exception') continue
      expect(gate.prCoverage.reason?.trim().length ?? 0, `gate "${gate.id}"`).toBeGreaterThan(0)
    }
  })

  it('the set of exception gate ids exactly matches the pinned allowlist', () => {
    const exceptionIds = releaseOnlyGates(matrix.gates)
      .filter((g) => g.prCoverage?.kind === 'exception')
      .map((g) => g.id)
      .sort()
    expect(exceptionIds).toEqual([...EXCEPTION_ALLOWLIST].sort())
  })
})
