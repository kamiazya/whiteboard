// CI's `packaged-smoke` job is the one gate that reproduces a packaged-entry
// break (a server-mode app built without a dependency typechecks, lints and
// builds green), so a session has to be able to run exactly what it runs.
//
// `smoke:claude` and `smoke:codex` cannot be part of that: they skip cleanly on
// a runner with no CLI, but on a developer machine where the CLI is installed
// they launch a real session and spend API quota. The job therefore names the
// quota-free root script, and the quota-spending chain stays a separate one.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { extractWorkflowJobs } from './workflow-jobs.js'

const QUOTA_SPENDING = /smoke:(?:claude|codex)(?![\w:-])/
const BARE_PNPM_SCRIPT = /(?:^|&&|\|\|)\s*pnpm\s+([a-z][\w:-]*)/g

const rootScripts = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>
  }
).scripts

function packagedSmokeCommands(): string[] {
  const jobs = extractWorkflowJobs(
    readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8'),
  )
  const job = jobs.find((candidate) => candidate.id === 'packaged-smoke')
  if (job === undefined) throw new Error('ci.yml has no `packaged-smoke` job')
  return job.steps
    .map((step) => step.run)
    .filter((run): run is string => run?.startsWith('pnpm ') === true)
}

/** The bodies of every root script a command reaches through bare `pnpm <name>` delegation. */
function expandedBodies(command: string, seen = new Set<string>()): string[] {
  const bodies = [command]
  for (const match of command.matchAll(BARE_PNPM_SCRIPT)) {
    const name = match[1]
    const body = name === undefined ? undefined : rootScripts[name]
    if (name === undefined || body === undefined || seen.has(name)) continue
    seen.add(name)
    bodies.push(...expandedBodies(body, seen))
  }
  return bodies
}

describe('the packaged-smoke job', () => {
  it('runs no step that spends CLI API quota', () => {
    const offending = packagedSmokeCommands().filter((command) =>
      expandedBodies(command).some((body) => QUOTA_SPENDING.test(body)),
    )

    expect(
      offending,
      '`smoke:claude` / `smoke:codex` launch a real CLI session wherever the CLI is on PATH. ' +
        'Name `smoke:distribution:packaged:node`, which is the same job minus those two.',
    ).toEqual([])
  })

  // Without this the expansion matching nothing — a renamed job, a script the
  // walk cannot follow — would make the assertion above pass over nothing.
  it('still reaches the packaged node smokes it is meant to run', () => {
    const bodies = packagedSmokeCommands().flatMap((command) => expandedBodies(command))
    const scripts = bodies.flatMap(
      (body) => body.match(/tests\/e2e\/distribution\/packaged-[\w-]+\.mjs/g) ?? [],
    )

    expect(new Set(scripts).size).toBe(7)
  })

  it('has the quota-spending chain available separately, beside the node one', () => {
    expect(rootScripts['smoke:distribution:packaged']).toMatch(QUOTA_SPENDING)
    expect(rootScripts['smoke:distribution:packaged']).toContain(
      'pnpm smoke:distribution:packaged:node',
    )
  })
})
