#!/usr/bin/env node

// @whiteboard/checks — the command line over affected.mjs, for ci.yml's
// scoped jobs and `pnpm test:affected`. The selection itself, and why it is
// shaped as it is, is affected.mjs.
//
// node tools/checks/src/affected-cli.mjs plan --event <github.event_name> [--base <ref>]
// node tools/checks/src/affected-cli.mjs job <job-id> --event <github.event_name> [--base <ref>]
// node tools/checks/src/affected-cli.mjs run <job-id> [vitest args…]   (AFFECTED_PROJECTS env)
// node tools/checks/src/affected-cli.mjs local [--base <ref>] [--list]

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attributeProjects,
  failOpenJob,
  jobUniverse,
  PACKAGE_JOBS,
  PROJECT_JOBS,
  parseNameStatus,
  planScope,
  readGraph,
  readRepoInputs,
  validateSelection,
} from './affected.mjs'
import { isRunAsScript } from './is-run-as-script.mjs'
import { readVitestProjects } from './vitest-projects.mjs'

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** @param {string[]} argv */
function option(argv, name, fallback) {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}

/** @param {string} repoRoot @param {string} base @param {boolean} workingTree */
function readChanges(repoRoot, base, workingTree) {
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  const range = workingTree ? [base] : [base, 'HEAD']
  const changes = parseNameStatus(git(['diff', '--name-status', '--no-renames', ...range]))
  if (workingTree) {
    for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
      if (path) changes.push({ status: 'A', path })
    }
  }
  return changes
}

/** @param {Record<string, string>} values */
function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  for (const line of lines) process.stderr.write(`[affected] ${line}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

/** @param {Plan} plan */
function summaryMarkdown(plan) {
  const rows = Object.entries(plan.jobs).map(
    ([job, { run, reason }]) => `| \`${job}\` | ${run ? 'runs' : '**skipped**'} | ${reason} |`,
  )
  return [
    `### Change scope: ${plan.everything ? 'everything' : `${plan.projects.length} project(s)`}`,
    '',
    ...plan.reasons.slice(0, 20).map((reason) => `- ${reason}`),
    '',
    '| job | | why |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

/** @param {string} repoRoot @param {string} base @param {string} event */
function computePlan(repoRoot, base, event, workingTree = false) {
  const inputs = readRepoInputs(repoRoot)
  // Only a pull request has a base worth diffing against; every other event
  // selects everything without asking git anything.
  const changes = event === 'pull_request' ? readChanges(repoRoot, base, workingTree) : []
  return { inputs, plan: planScope({ changes, event, ...inputs }) }
}

/** @param {string} repoRoot @param {string[]} args */
function spawnVitest(repoRoot, args) {
  const result = spawnSync('pnpm', args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(`[affected] pnpm could not start: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error))

/**
 * The scope job: the whole plan, for ci-gate and the run summary. It FAILS
 * rather than guessing, and ci-gate fails with it; each job's own detection
 * fails open independently.
 * @typedef {{ repoRoot: string, rest: string[], base: string, event: string }} CommandInput
 * @param {CommandInput} input
 */
function planCommand({ repoRoot, base, event }) {
  let plan
  try {
    ;({ plan } = computePlan(repoRoot, base, event))
  } catch (error) {
    process.stderr.write(`[affected] could not compute the plan: ${message(error)}\n`)
    return 1
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  writeOutputs({ plan: JSON.stringify({ everything: plan.everything, jobs: plan.jobs }) })
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(plan))
  }
  return 0
}

/**
 * One job's detection step: `run`, `projects` and `reason` outputs. An error
 * computing the selection runs the job's whole universe.
 * @param {CommandInput} input
 */
function jobCommand({ repoRoot, rest, base, event }) {
  const jobId = rest[0]
  if (!PROJECT_JOBS.includes(jobId) && !(jobId in PACKAGE_JOBS)) {
    process.stderr.write(`[affected] ${jobId} is not a scoped job\n`)
    return 1
  }
  /** @type {JobPlan} */
  let job
  try {
    job = computePlan(repoRoot, base, event).plan.jobs[jobId]
  } catch (error) {
    let projects = null
    try {
      projects = attributeProjects(readVitestProjects(repoRoot), readGraph(repoRoot))
    } catch {
      if (PROJECT_JOBS.includes(jobId)) {
        // Not even the universe is readable: there is nothing sane to run.
        process.stderr.write(`[affected] cannot read the project inventory: ${message(error)}\n`)
        return 1
      }
    }
    job = failOpenJob(jobId, projects, message(error))
  }
  writeOutputs({
    run: String(job.run),
    projects: JSON.stringify(job.projects ?? []),
    reason: job.reason.replace(/\n/g, ' '),
  })
  return 0
}

/**
 * A scoped job's vitest step: the names arrive from the detection step
 * through AFFECTED_PROJECTS and are checked before vitest sees them.
 * @param {CommandInput} input
 */
function runCommand({ repoRoot, rest }) {
  const jobId = rest[0]
  const forwarded = rest.slice(1).filter((arg) => arg !== '--')
  let names
  try {
    const projects = attributeProjects(readVitestProjects(repoRoot), readGraph(repoRoot))
    const raw = process.env.AFFECTED_PROJECTS
    if (raw === undefined) throw new Error('AFFECTED_PROJECTS is unset')
    names = validateSelection(JSON.parse(raw), jobUniverse(jobId, projects))
  } catch (error) {
    process.stderr.write(`[affected] refusing to run vitest: ${message(error)}\n`)
    return 1
  }
  process.stderr.write(`[affected] ${jobId}: ${names.join(', ')}\n`)
  const args = ['exec', 'vitest', 'run', ...names.map((name) => `--project=${name}`), ...forwarded]
  // A shard can draw no file when the selection is small; the names were
  // just checked against the inventory, so "no test files" here is the
  // shard split, not a filter that matched nothing.
  if (forwarded.some((arg) => arg.startsWith('--shard'))) args.push('--passWithNoTests')
  return spawnVitest(repoRoot, args)
}

/**
 * `pnpm test:affected`: the same selection against the merge base with
 * origin/main, working tree and untracked files included.
 * @param {CommandInput} input
 */
function localCommand({ repoRoot, rest }) {
  const ref = option(rest, '--base', 'origin/main')
  const mergeBase = execFileSync('git', ['merge-base', ref, 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const { inputs, plan } = computePlan(repoRoot, mergeBase, 'pull_request', true)
  process.stdout.write(summaryMarkdown(plan))
  // The verify job's projects need a build first (mcp-smoke); CI runs them.
  const runnable = inputs.projects
    .filter((p) => plan.projects.includes(p.name) && PROJECT_JOBS.includes(p.job))
    .map((p) => p.name)
  const ciOnly = plan.projects.filter((name) => !runnable.includes(name))
  if (ciOnly.length > 0) {
    process.stdout.write(`\nleft to CI (needs a build first): ${ciOnly.join(', ')}\n`)
  }
  if (rest.includes('--list')) {
    process.stdout.write(`\n${runnable.join('\n')}\n`)
    return 0
  }
  if (runnable.length === 0) {
    process.stdout.write('\nno vitest project is affected\n')
    return 0
  }
  const args = ['exec', 'vitest', 'run', ...runnable.map((name) => `--project=${name}`)]
  process.stdout.write(`\npnpm ${args.join(' ')}\n`)
  return spawnVitest(repoRoot, args)
}

const COMMANDS = { plan: planCommand, job: jobCommand, run: runCommand, local: localCommand }

/** @param {string[]} argv @param {string} repoRoot */
export function main(argv, repoRoot = DEFAULT_REPO_ROOT) {
  const [command, ...rest] = argv
  const handler = COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)]
  if (!handler) {
    process.stderr.write(
      'usage: affected-cli.mjs plan|job <id>|run <id>|local [--base <ref>] [--event <name>]\n',
    )
    return 1
  }
  // HEAD^1: on a pull_request event the checkout is the merge commit, whose
  // first parent is the base tip. An absent --event is not a pull request, so
  // it selects everything.
  const base = option(rest, '--base', 'HEAD^1')
  const event = option(rest, '--event', 'unspecified')
  return handler({ repoRoot, rest, base, event })
}

if (isRunAsScript(import.meta.url)) process.exit(main(process.argv.slice(2)))
