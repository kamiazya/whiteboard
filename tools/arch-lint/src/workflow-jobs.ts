import { parse as parseYaml } from 'yaml'

interface WorkflowStep {
  name: string
  run: string | null
  if: string | null
}

export interface WorkflowJob {
  id: string
  if: string | null
  needs: string[]
  steps: WorkflowStep[]
}

interface ParsedWorkflow {
  jobs?: Record<
    string,
    {
      if?: string
      needs?: string | string[]
      steps?: { name?: string; run?: string; if?: string }[]
    }
  >
}

/**
 * The jobs and steps a GitHub Actions workflow declares, for the release
 * lane's isomorphism and gate tests.
 *
 * This was a 184-line indentation scanner in `tools/checks`, at cognitive
 * complexity 62. That package stays dependency-free because it is the last
 * mile before a real publish and must not need this repo's build pipeline to
 * validate its own policy file; this extractor is not on that path — every
 * one of its callers is a test in this directory, and `yaml` is already a
 * dependency here.
 *
 * The scanner did not merely fail to support a multi-line `run: |` block, as
 * its header claimed. It reported the step with `run` set to the literal
 * string `"|"`, and a folded `if: >-` as `">-"` — a value that reads like a
 * command and is not one. Measured across all 11 workflows: the job and step
 * COUNTS agreed everywhere, and 14 steps carried one of those two placeholders
 * instead of their text. A parse answers what the file says.
 */
export function extractWorkflowJobs(yamlText: string): WorkflowJob[] {
  const workflow = (parseYaml(yamlText) ?? {}) as ParsedWorkflow
  return Object.entries(workflow.jobs ?? {}).map(([id, job]) => ({
    id,
    if: job?.if ?? null,
    needs: job?.needs === undefined ? [] : [job.needs].flat(),
    steps: (job?.steps ?? []).map((step) => ({
      name: step?.name ?? '',
      run: step?.run ?? null,
      if: step?.if ?? null,
    })),
  }))
}
