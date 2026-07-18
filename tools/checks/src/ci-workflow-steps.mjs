// @whiteboard/checks — minimal GitHub Actions workflow step extractor.
//
// tools/checks stays dependency-free (see release-gate-matrix-schema.mjs), so
// this is NOT a general YAML parser: it is a line/indentation scanner scoped to
// the specific shape this repo's own workflow files are written in — a top-level
// `jobs:` map, each job a `steps:` list, each step a `- name: ... / if: ... /
// run: <single-line command>` block. It intentionally does not support anchors,
// flow-style collections, multi-line `run: |` blocks, or arbitrary YAML nesting.
// If a workflow step needed for gate-isomorphism coverage stops parsing here,
// that is a signal to keep the step shape simple, not to grow this into a real
// YAML parser.

/**
 * @typedef {{ name: string, run: string | null, if: string | null }} WorkflowStep
 * @typedef {{ id: string, if: string | null, steps: WorkflowStep[] }} WorkflowJob
 */

function indentOf(line) {
  const match = line.match(/^( *)/)
  return match ? match[1].length : 0
}

// Blank lines and full-line comments carry no indentation meaning in YAML —
// a comment can be dedented below its logical block's indent without ending
// that block. Every scan loop below must skip both before treating a line's
// indentation as a dedent signal, or a stray comment silently truncates the
// job/step/env list being parsed.
function isBlankOrComment(line) {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/**
 * Extract job id / job-level `if` / steps (name, run, if) from a GitHub Actions
 * workflow YAML string, restricted to the subset described above.
 * @param {string} yamlText
 * @returns {WorkflowJob[]}
 */
export function extractWorkflowJobs(yamlText) {
  const lines = yamlText.split('\n')
  const jobsLineIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsLineIdx === -1) return []

  /** @type {WorkflowJob[]} */
  const jobs = []
  let i = jobsLineIdx + 1
  const jobsIndent = 2 // this repo's workflows indent job ids two spaces under `jobs:`

  while (i < lines.length) {
    const line = lines[i]
    if (isBlankOrComment(line)) {
      i++
      continue
    }
    const indent = indentOf(line)
    if (indent < jobsIndent) break // dedented past the jobs map (e.g. a trailing top-level key)
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (indent === jobsIndent && jobMatch) {
      const jobId = jobMatch[1]
      const jobBodyIndent = jobsIndent + 2
      let jobIf = null
      /** @type {WorkflowStep[]} */
      const steps = []
      i++
      while (i < lines.length) {
        const bodyLine = lines[i]
        if (isBlankOrComment(bodyLine)) {
          i++
          continue
        }
        const bodyIndent = indentOf(bodyLine)
        if (bodyIndent < jobBodyIndent) break // end of this job's body
        const ifMatch = bodyLine.match(/^ {4}if:\s*(.+)$/)
        if (bodyIndent === jobBodyIndent && ifMatch) {
          jobIf = ifMatch[1].trim()
          i++
          continue
        }
        const stepsMatch = bodyLine.match(/^ {4}steps:\s*$/)
        if (bodyIndent === jobBodyIndent && stepsMatch) {
          i++
          const parsed = parseSteps(lines, i, jobBodyIndent + 2)
          steps.push(...parsed.steps)
          i = parsed.nextIndex
          continue
        }
        i++
      }
      jobs.push({ id: jobId, if: jobIf, steps })
      continue
    }
    i++
  }
  return jobs
}

// Parse a `steps:` list starting at `startIndex`, where each step begins with a
// `- ` line at `stepIndent` and step-body keys (name/if/run/…) are indented two
// further spaces. Returns the parsed steps and the index just past the list.
function parseSteps(lines, startIndex, stepIndent) {
  /** @type {import('./ci-workflow-steps.mjs').WorkflowStep[]} */
  const steps = []
  let i = startIndex
  const stepDashPrefix = ' '.repeat(stepIndent) + '- '
  while (i < lines.length) {
    const line = lines[i]
    if (isBlankOrComment(line)) {
      i++
      continue
    }
    const indent = indentOf(line)
    if (indent < stepIndent) break
    if (indent === stepIndent && line.startsWith(stepDashPrefix)) {
      let name = ''
      let run = null
      let stepIf = null
      // The first step key can appear on the `- ` line itself (e.g. `- name: X`).
      const firstKeyLine = line.slice(stepDashPrefix.length)
      const bodyIndent = stepIndent + 2
      const applyKey = (text) => {
        const nameM = text.match(/^name:\s*(.+)$/)
        if (nameM) name = nameM[1].trim()
        const ifM = text.match(/^if:\s*(.+)$/)
        if (ifM) stepIf = ifM[1].trim()
        const runM = text.match(/^run:\s*(.+)$/)
        if (runM) run = runM[1].trim()
      }
      applyKey(firstKeyLine)
      i++
      while (i < lines.length) {
        const bodyLine = lines[i]
        if (isBlankOrComment(bodyLine)) {
          i++
          continue
        }
        const bIndent = indentOf(bodyLine)
        if (bIndent < bodyIndent) break // dedent: next step or end of steps list
        if (bIndent === bodyIndent) applyKey(bodyLine.trim())
        i++
      }
      steps.push({ name, run, if: stepIf })
      continue
    }
    break
  }
  return { steps, nextIndex: i }
}
