// @whiteboard/checks — can this diff change what SonarQube would report?
//
// The analysis is 14-28 minutes of full coverage collection and is report-only,
// so a pull request that cannot move its numbers should not pay for it. What
// cannot move them is DERIVED, not listed: a path SonarQube is told to
// exclude (`sonar.exclusions` in sonar-project.properties, read here) is never
// analysed, so changing it changes nothing; Markdown is not source it parses.
// A path nobody can classify counts as material, so the failure of this rule
// is an analysis that ran needlessly — never one that was silently skipped.
//
// Coverage-only exclusions (`sonar.coverage.exclusions`, e.g. `.claude/**`) do
// NOT make a path inert: those files are still analysed for duplication and
// maintainability, which is what this workflow exists to track.
//
// tools/checks stays dependency-free, so this is plain text parsing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The comma-separated, backslash-continued value of one properties key.
 * @param {string} propertiesText
 * @param {string} key
 * @returns {string[]}
 */
export function propertyList(propertiesText, key) {
  const lines = propertiesText.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${key}=`))
  if (start === -1) return []
  let value = lines[start].slice(key.length + 1)
  let index = start
  while (value.trimEnd().endsWith('\\') && index + 1 < lines.length) {
    index += 1
    value = `${value.trimEnd().slice(0, -1)}${lines[index].trim()}`
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * SonarQube's pattern syntax: `**` crosses directories, `*` does not, and a
 * pattern that ends in `/**` also covers the directory's contents.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function sonarGlob(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/'
      // `**/` may match nothing, so `**/*.d.ts` also matches a top-level file.
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else {
      source += char.replace(/[.+^${}()|[\]\\?]/g, String.raw`\$&`)
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * @param {string[]} changedPaths repo-relative paths changed by the diff
 * @param {string[]} exclusions `sonar.exclusions` patterns
 * @returns {boolean} true when at least one path can change the analysis
 */
export function affectsSonarAnalysis(changedPaths, exclusions) {
  const excluded = exclusions.map(sonarGlob)
  return changedPaths.some((path) => !path.endsWith('.md') && !excluded.some((re) => re.test(path)))
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Usage: node tools/checks/src/sonar-analysis-inputs.mjs <base-ref|always>
//
// Prints `true` or `false`, and appends `analyze=<value>` to $GITHUB_OUTPUT.
// `always` is what a push to main and a manual run pass: the default branch's
// analysis is the project's record and is never skipped. Fails OPEN like
// docker-build-inputs.mjs — an unresolvable diff prints `true`.

if (process.argv[1]?.endsWith('sonar-analysis-inputs.mjs')) {
  const { execFileSync } = await import('node:child_process')
  const { appendFileSync } = await import('node:fs')

  let answer = true
  let why = 'diff could not be resolved; failing open'
  try {
    const baseRef = process.argv[2]
    if (!baseRef) throw new Error('missing <base-ref> argument')
    if (baseRef === 'always') {
      why = 'no PR base to diff against'
    } else {
      const changed = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
        encoding: 'utf-8',
      })
        .split('\n')
        .filter(Boolean)
      const properties = readFileSync(join(process.cwd(), 'sonar-project.properties'), 'utf-8')
      const exclusions = propertyList(properties, 'sonar.exclusions')
      if (exclusions.length === 0)
        throw new Error('sonar-project.properties has no sonar.exclusions')
      answer = affectsSonarAnalysis(changed, exclusions)
      why = `${changed.length} changed path(s) against ${exclusions.length} exclusion pattern(s)`
    }
  } catch (error) {
    why = `${why}: ${error instanceof Error ? error.message : String(error)}`
  }

  process.stderr.write(`[sonar-analysis-inputs] analyze=${answer} (${why})\n`)
  process.stdout.write(`${answer}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `analyze=${answer}\n`)
}
