// @whiteboard/checks — job/step env-scope scanner.
//
// A dedicated, narrowly-scoped indentation scanner for one hygiene question:
// does a given environment variable key appear in a GitHub Actions job's
// `env:` block (ambient to every step) or only in a specific step's `env:`
// block (scoped to that one step)? This is deliberately separate from
// ci-workflow-steps.mjs, whose header commits it to staying a simple
// name/run/if line-scanner — env blocks and their extra indentation level are
// a different concern with a different shape, and folding this in would grow
// that module past its stated scope.
//
// Like ci-workflow-steps.mjs, this is NOT a general YAML parser: it assumes
// this repo's own two-space indentation convention (`jobs:` -> 2-space job
// ids -> 4-space job body -> 6-space `- ` step items -> 8-space step body ->
// 10-space env entries).

function indentOf(line) {
  const match = line.match(/^( *)/)
  return match ? match[1].length : 0
}

/**
 * @typedef {{ jobId: string }} JobLevelHit
 * @typedef {{ jobId: string, stepName: string }} StepLevelHit
 * @typedef {{ jobLevel: JobLevelHit[], stepLevel: StepLevelHit[] }} EnvScanResult
 */

// Collect top-level keys of an `env:` block whose body starts at `envIndent`,
// returning whether `key` is among them and the index just past the block.
function scanEnvBlockKeys(lines, startIndex, envIndent, key) {
  const keyPattern = new RegExp(`^ {${envIndent}}([A-Za-z0-9_]+):`)
  let i = startIndex
  let found = false
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const indent = indentOf(line)
    if (indent < envIndent) break
    if (indent === envIndent) {
      const keyMatch = line.match(keyPattern)
      if (keyMatch && keyMatch[1] === key) found = true
    }
    i++
  }
  return { found, nextIndex: i }
}

/**
 * Scan a GitHub Actions workflow YAML string for every job-level and
 * step-level `env:` placement of `key`.
 * @param {string} yamlText
 * @param {string} key
 * @returns {EnvScanResult}
 */
export function scanEnvKeyPlacements(yamlText, key) {
  const lines = yamlText.split('\n')
  /** @type {JobLevelHit[]} */
  const jobLevel = []
  /** @type {StepLevelHit[]} */
  const stepLevel = []

  const jobsLineIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsLineIdx === -1) return { jobLevel, stepLevel }

  const jobsIndent = 2
  const jobBodyIndent = jobsIndent + 2 // 4
  const stepItemIndent = jobBodyIndent + 2 // 6
  const stepBodyIndent = stepItemIndent + 2 // 8
  const envBodyIndent = stepBodyIndent + 2 // 10

  let i = jobsLineIdx + 1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const indent = indentOf(line)
    if (indent < jobsIndent) break
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (indent !== jobsIndent || !jobMatch) {
      i++
      continue
    }
    const jobId = jobMatch[1]
    i++
    while (i < lines.length) {
      const bodyLine = lines[i]
      if (bodyLine.trim() === '') {
        i++
        continue
      }
      const bodyIndent = indentOf(bodyLine)
      if (bodyIndent < jobBodyIndent) break

      if (bodyIndent === jobBodyIndent && /^ {4}env:\s*$/.test(bodyLine)) {
        const { found, nextIndex } = scanEnvBlockKeys(lines, i + 1, jobBodyIndent + 2, key)
        if (found) jobLevel.push({ jobId })
        i = nextIndex
        continue
      }

      if (bodyIndent === jobBodyIndent && /^ {4}steps:\s*$/.test(bodyLine)) {
        i++
        while (i < lines.length) {
          const stepLine = lines[i]
          if (stepLine.trim() === '') {
            i++
            continue
          }
          const stIndent = indentOf(stepLine)
          if (stIndent < stepItemIndent) break
          const dashPrefix = ' '.repeat(stepItemIndent) + '- '
          if (stIndent !== stepItemIndent || !stepLine.startsWith(dashPrefix)) break

          let stepName = ''
          let hasKey = false
          const firstKeyText = stepLine.slice(dashPrefix.length)
          const firstNameMatch = firstKeyText.match(/^name:\s*(.+)$/)
          if (firstNameMatch) stepName = firstNameMatch[1].trim()
          i++
          while (i < lines.length) {
            const bLine = lines[i]
            if (bLine.trim() === '') {
              i++
              continue
            }
            const bIndent = indentOf(bLine)
            if (bIndent < stepBodyIndent) break
            if (bIndent === stepBodyIndent) {
              const nameMatch = bLine.trim().match(/^name:\s*(.+)$/)
              if (nameMatch) stepName = nameMatch[1].trim()
              if (/^ {8}env:\s*$/.test(bLine)) {
                const { found, nextIndex } = scanEnvBlockKeys(lines, i + 1, envBodyIndent, key)
                if (found) hasKey = true
                i = nextIndex
                continue
              }
            }
            i++
          }
          if (hasKey) stepLevel.push({ jobId, stepName })
        }
        continue
      }

      i++
    }
  }

  return { jobLevel, stepLevel }
}
