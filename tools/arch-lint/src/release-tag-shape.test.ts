// release.yml's npm and Docker jobs refuse to publish a tag that is not
// `mcp-server-v<semver>`. The tag can come from `workflow_dispatch`'s
// `force_publish_tag`, so the check is the boundary between a typed string and
// a publish; a pattern anchored only at the start accepts anything after a
// valid prefix. These run each job's real step under bash.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

interface Step {
  name?: string
  run?: string
}

const release = parseYaml(
  readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8'),
) as {
  jobs: Record<string, { steps?: Step[] }>
}
const tagSteps = Object.entries(release.jobs).flatMap(([job, { steps = [] }]) =>
  steps.filter((s) => s.name === 'Validate tag shape').map((s) => ({ job, run: s.run ?? '' })),
)

function accepts(run: string, tag: string): boolean {
  const res = spawnSync('bash', ['-e', '-c', run], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TAG: tag },
    encoding: 'utf-8',
  })
  return res.status === 0
}

describe('release.yml — the tag shape check matches the whole tag', () => {
  it('finds the check in both publishing jobs', () => {
    expect(tagSteps.length).toBe(2)
  })

  for (const tag of ['mcp-server-v0.0.9', 'mcp-server-v12.3.45']) {
    it(`accepts ${tag}`, () => {
      for (const { job, run } of tagSteps) expect(accepts(run, tag), job).toBe(true)
    })
  }

  for (const tag of [
    'mcp-server-v0.0.9-evil',
    'mcp-server-v0.0.9;id',
    'mcp-server-v0.0.9 extra',
    'mcp-server-v0.0.9\nmain',
    'mcp-server-v0.0',
    'xmcp-server-v0.0.9',
  ]) {
    it(`refuses ${JSON.stringify(tag)}`, () => {
      for (const { job, run } of tagSteps) expect(accepts(run, tag), job).toBe(false)
    })
  }
})
