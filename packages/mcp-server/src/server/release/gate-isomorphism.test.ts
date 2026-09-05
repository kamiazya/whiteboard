// Gate isomorphism: every gate on a prCoverage-required tier (see
// PR_COVERAGE_REQUIRED_TIERS below) must have a declared,
// structurally-verified prCoverage tying it to a real, PR-reachable ci.yml
// job or step. This is the pillar-A guard against
// the failure mode that caused the v0.0.7-v0.0.18 outage: a step that only
// ran on the release tag drifted out of sync with the rest of the pipeline
// for weeks before its first (and only) execution finally caught it.
//
// prCoverage.kind:
//  - 'workflow-step': the exact gate command must run as a named step inside
//    a specific ci.yml job, and neither the job nor the step may be gated
//    behind an `if:` outside the pinned always-true-on-PR allowlist below.
//  - 'aggregate': a coarser claim — the named ci.yml job exists and is
//    PR-reachable, and its step `run` commands contain every substring
//    listed in `expectedCommandSubstrings`.
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
  kind: 'workflow-step' | 'conditional-workflow-step' | 'aggregate' | 'exception'
  workflow?: string
  jobId?: string
  stepName?: string
  reason?: string
  condition?: string
  conditionReason?: string
  expectedCommandSubstrings?: string[]
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
//
// It holds ONE gate. Its sibling smoke:docker left the list: it now runs in
// ci.yml's dry-run-docker job against the image that job already built, and
// its ten scenarios pass. smoke:docker-backup-restore stays, but with a reason
// that is now a measurement instead of prose — running it is what showed it
// asserts against a route the server no longer has. The old reason for both
// ("the release-candidate docker path exercised by the dry-run-docker job")
// was never true: that job builds an image and never runs a container.
const EXCEPTION_ALLOWLIST = new Set<string>(['smoke:docker-backup-restore'])

function isJobPrReachable(job: WorkflowJob): boolean {
  return job.if === null || ALWAYS_TRUE_ON_PR_IF.has(job.if)
}

function isStepPrReachable(step: WorkflowStep): boolean {
  return step.if === null || ALWAYS_TRUE_ON_PR_IF.has(step.if)
}

// Two opposite reasons a tier lands here, both needing the same guard.
//  - 'publish' / 'docker-release': the gate runs on a release tag, so its
//    prCoverage is the claim that a pull request exercises it TOO — the
//    pillar-A property this file was written for.
//  - 'publish-dry-run': the gate runs on a pull request and NOWHERE else, so
//    its prCoverage is not a second copy but the only record of where it
//    runs. Undeclared, the ci.yml step could be renamed or dropped and no
//    policy file would notice; that is the state both `publish:dry-run:*`
//    jobs were actually in.
const PR_COVERAGE_REQUIRED_TIERS = ['publish', 'docker-release', 'publish-dry-run']

function prCoverageRequiredGates(gates: ReleaseGate[]): ReleaseGate[] {
  return gates.filter((g) => g.requiredFor.some((t) => PR_COVERAGE_REQUIRED_TIERS.includes(t)))
}

// The only workflow file this test loads and resolves jobs/steps against.
// prCoverage.workflow is a required, schema-validated field, but until this
// constant is checked against it, a declaration naming a different or
// nonexistent workflow file (e.g. a copy-pasted "release.yml") would still
// resolve — because the job/step lookup below always searches ci.yml
// regardless of what prCoverage.workflow says. Asserting the match is what
// makes the field load-bearing instead of decorative.
const LOADED_WORKFLOW_FILE = 'ci.yml'

function expectCoverageWorkflowMatchesLoadedFile(gate: ReleaseGate, coverage: PrCoverage): void {
  expect(
    coverage.workflow,
    `gate "${gate.id}": prCoverage.workflow "${coverage.workflow}" does not match the workflow file this check resolves against ("${LOADED_WORKFLOW_FILE}")`,
  ).toBe(LOADED_WORKFLOW_FILE)
}

describe('release-gate-matrix.json is a valid matrix (schema authority)', () => {
  it('passes the shared validator', async () => {
    const { validateMatrix } = await loadSchema()
    const result = validateMatrix(matrix)
    expect(result.ok, result.reason).toBe(true)
  })
})

describe('every gate on a prCoverage-required tier declares prCoverage', () => {
  it('has no gate on a prCoverage-required tier missing its declaration', () => {
    const missing = prCoverageRequiredGates(matrix.gates)
      .filter((g) => !g.prCoverage)
      .map((g) => g.id)
    expect(missing).toEqual([])
  })
})

describe('gate isomorphism: workflow-step coverage resolves structurally', () => {
  it('every workflow-step prCoverage points at an existing, PR-reachable ci.yml step', async () => {
    const { extractWorkflowJobs } = await loadExtractor()
    const jobs = extractWorkflowJobs(ciYaml)
    for (const gate of prCoverageRequiredGates(matrix.gates)) {
      const coverage = gate.prCoverage
      if (coverage?.kind !== 'workflow-step') continue
      expectCoverageWorkflowMatchesLoadedFile(gate, coverage)
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

// A conditional step is the one shape 'workflow-step' cannot express without
// lying: its `if:` is by definition NOT in the always-true-on-PR allowlist, so
// declaring it as a plain workflow-step would either fail that check or force
// the allowlist open — and an allowlist widened to admit a real condition
// stops meaning anything. The declared `condition` is checked against the
// step's actual `if:` instead, so the two cannot drift.
describe('gate isomorphism: conditional coverage matches the step condition it declares', () => {
  it('every conditional-workflow-step prCoverage resolves and its condition equals the step if:', async () => {
    const { extractWorkflowJobs } = await loadExtractor()
    const jobs = extractWorkflowJobs(ciYaml)
    for (const gate of prCoverageRequiredGates(matrix.gates)) {
      const coverage = gate.prCoverage
      if (coverage?.kind !== 'conditional-workflow-step') continue
      expectCoverageWorkflowMatchesLoadedFile(gate, coverage)
      const job = jobs.find((j) => j.id === coverage.jobId)
      expect(job, `gate "${gate.id}": job "${coverage.jobId}" not found in ci.yml`).toBeDefined()
      expect(
        isJobPrReachable(job!),
        `gate "${gate.id}": job "${coverage.jobId}" has a non-pinned if: "${job!.if}" — a conditional gate is gated at the STEP, so the job itself must still report on every pull request`,
      ).toBe(true)
      const step = job!.steps.find((s) => s.name === coverage.stepName)
      expect(
        step,
        `gate "${gate.id}": step "${coverage.stepName}" not found in job "${coverage.jobId}"`,
      ).toBeDefined()
      expect(
        step!.run,
        `gate "${gate.id}": step "${coverage.stepName}" must run the gate's exact command`,
      ).toBe(gate.command)
      expect(
        step!.if,
        `gate "${gate.id}": declared condition does not match step "${coverage.stepName}"'s actual if:`,
      ).toBe(coverage.condition)
    }
  })
})

describe('gate isomorphism: aggregate coverage resolves to a PR-reachable job', () => {
  it('every aggregate prCoverage points at an existing, PR-reachable ci.yml job', async () => {
    const { extractWorkflowJobs } = await loadExtractor()
    const jobs = extractWorkflowJobs(ciYaml)
    for (const gate of prCoverageRequiredGates(matrix.gates)) {
      const coverage = gate.prCoverage
      if (coverage?.kind !== 'aggregate') continue
      expectCoverageWorkflowMatchesLoadedFile(gate, coverage)
      const job = jobs.find((j) => j.id === coverage.jobId)
      expect(job, `gate "${gate.id}": job "${coverage.jobId}" not found in ci.yml`).toBeDefined()
      expect(
        isJobPrReachable(job!),
        `gate "${gate.id}": job "${coverage.jobId}" has a non-pinned if: "${job!.if}"`,
      ).toBe(true)
      // Guards the concrete regression this coverage kind is weakest against:
      // an aggregate declaration only asserts the job exists and is
      // PR-reachable, never that it still does anything. Deleting every
      // substantive step from job "check" (leaving only checkout/setup)
      // would otherwise still satisfy this check.
      const substantiveSteps = job!.steps.filter((s) => s.run !== null)
      expect(
        substantiveSteps.length,
        `gate "${gate.id}": job "${coverage.jobId}" has no steps with a run command left — an aggregate coverage claim requires the job to still do something`,
      ).toBeGreaterThan(0)
    }
  })

  it('every aggregate prCoverage with expectedCommandSubstrings finds each substring in a job step run command', async () => {
    const { extractWorkflowJobs } = await loadExtractor()
    const jobs = extractWorkflowJobs(ciYaml)
    for (const gate of prCoverageRequiredGates(matrix.gates)) {
      const coverage = gate.prCoverage
      if (coverage?.kind !== 'aggregate') continue
      if (!coverage.expectedCommandSubstrings || coverage.expectedCommandSubstrings.length === 0)
        continue
      const job = jobs.find((j) => j.id === coverage.jobId)
      expect(job).toBeDefined()
      const allRunCommands = job!.steps
        .filter((s) => s.run !== null)
        .map((s) => s.run!)
        .join('\n')
      for (const substring of coverage.expectedCommandSubstrings) {
        expect(
          allRunCommands,
          `gate "${gate.id}": expectedCommandSubstring "${substring}" not found in any run step of job "${coverage.jobId}"`,
        ).toContain(substring)
      }
    }
  })

  it('every aggregate gate declares expectedCommandSubstrings', () => {
    for (const gate of prCoverageRequiredGates(matrix.gates)) {
      const coverage = gate.prCoverage
      if (coverage?.kind !== 'aggregate') continue
      expect(
        coverage.expectedCommandSubstrings,
        `gate "${gate.id}": aggregate prCoverage must declare expectedCommandSubstrings`,
      ).toBeDefined()
      expect(
        coverage.expectedCommandSubstrings!.length,
        `gate "${gate.id}": expectedCommandSubstrings must be non-empty`,
      ).toBeGreaterThan(0)
    }
  })
})

describe('gate isomorphism: exceptions are explicit and pinned', () => {
  it('every exception has a non-empty reason', () => {
    for (const gate of prCoverageRequiredGates(matrix.gates)) {
      if (gate.prCoverage?.kind !== 'exception') continue
      expect(gate.prCoverage.reason?.trim().length ?? 0, `gate "${gate.id}"`).toBeGreaterThan(0)
    }
  })

  it('the set of exception gate ids exactly matches the pinned allowlist', () => {
    const exceptionIds = prCoverageRequiredGates(matrix.gates)
      .filter((g) => g.prCoverage?.kind === 'exception')
      .map((g) => g.id)
      .sort()
    expect(exceptionIds).toEqual([...EXCEPTION_ALLOWLIST].sort())
  })
})

// Proves prCoverage.workflow is load-bearing rather than decorative: a
// workflow-step/aggregate declaration naming a file other than the one this
// test actually loads and resolves jobs/steps against must fail, even when
// the jobId/stepName happen to exist in the loaded file.
describe('gate isomorphism: prCoverage.workflow must name the workflow file this check resolves against', () => {
  it('rejects a workflow-step coverage naming a different workflow file', async () => {
    const { extractWorkflowJobs } = await loadExtractor()
    const jobs = extractWorkflowJobs(ciYaml)
    const gate: ReleaseGate = {
      id: 'fixture',
      command: 'pnpm typecheck',
      requiredFor: ['publish'],
      requiresDocker: false,
      prCoverage: {
        kind: 'workflow-step',
        workflow: 'release.yml',
        jobId: 'check',
        stepName: 'Typecheck',
      },
    }
    const job = jobs.find((j) => j.id === gate.prCoverage!.jobId)
    expect(job, 'fixture job must exist in ci.yml for this to be a meaningful check').toBeDefined()
    expect(() => expectCoverageWorkflowMatchesLoadedFile(gate, gate.prCoverage!)).toThrow()
  })
})
