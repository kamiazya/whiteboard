// The `dry-run-docker` skip rests on one claim: a pull request that touches
// nothing the image compiles cannot change whether Dockerfile.server builds.
// Everything here exists to keep that claim true rather than remembered.
//
// The affecting set is derived twice over — the build targets are read out of
// the Dockerfile, and the package set is their workspace closure — so the two
// ways it normally rots are closed: a third `pnpm --filter` line in the
// Dockerfile widens the closure automatically, and a package leaving the
// dependency graph stops being listed rather than lingering as a stale path.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

const MODULE_PATH = join(ROOT, 'tools/checks/src/docker-build-inputs.mjs')

const { dockerBuildTargets, workspaceClosure, indexManifests, affectsDockerBuild, inertChange } =
  (await import(pathToFileURL(MODULE_PATH).href)) as {
    dockerBuildTargets: (dockerfileText: string) => string[]
    workspaceClosure: (
      roots: string[],
      byName: Map<string, { dir: string; manifest: Record<string, unknown> }>,
    ) => string[]
    indexManifests: (
      repoRoot: string,
      manifestPaths: string[],
    ) => Map<string, { dir: string; manifest: Record<string, unknown> }>
    affectsDockerBuild: (changedPaths: string[], closureDirs: string[]) => boolean
    inertChange: (path: string, before: string | null, after: string | null) => boolean
  }

const dockerfile = readFileSync(join(ROOT, 'Dockerfile.server'), 'utf-8')
// Manifest discovery mirrors the CLI's `git ls-files`, without shelling out:
// the workspace globs are fixed shapes in this repo (packages/*, apps/*,
// tools/*), so a directory read is enough and stays dependency-free.
function manifestPaths(): string[] {
  const paths = ['package.json']
  for (const group of ['packages', 'apps', 'tools']) {
    const groupDir = join(ROOT, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rel = `${group}/${entry.name}/package.json`
      if (existsSync(join(ROOT, rel))) paths.push(rel)
    }
  }
  return paths
}

const byName = indexManifests(ROOT, manifestPaths())
const targets = dockerBuildTargets(dockerfile)
const closure = workspaceClosure(targets, byName)

describe('docker build targets are read out of Dockerfile.server', () => {
  it('finds every pnpm --filter target the image builds', () => {
    expect(targets).toEqual(['@kamiazya/whiteboard-canvas-viewer', '@kamiazya/whiteboard-mcp'])
  })

  it('resolves each target to a workspace package', () => {
    for (const target of targets) {
      expect(byName.has(target), `Dockerfile target "${target}" is not a workspace package`).toBe(
        true,
      )
    }
  })

  it('a Dockerfile that builds a third package widens the target list', () => {
    const widened = `${dockerfile}\nRUN pnpm --filter @kamiazya/whiteboard-web build\n`
    expect(dockerBuildTargets(widened)).toContain('@kamiazya/whiteboard-web')
  })
})

describe('the closure covers what the image compiles', () => {
  it('contains the composition root the image ships', () => {
    expect(closure).toContain('packages/mcp-server')
  })

  it('reaches transitively — a package no target names directly is included', () => {
    // model is a dependency of a dependency, never named by the Dockerfile.
    expect(closure).toContain('packages/model')
  })

  // This is the claim the skip actually rests on, and it is not a coincidence
  // of the current graph: architecture-map rule 2 forbids any shared package
  // from importing a composition root, and web-app-boundary.test.ts pins the
  // apps/web half. If that ever changed, apps/web would enter the closure here
  // and this test would say so before the skip started hiding a real break.
  it('excludes apps/web, the composition root nothing in the image depends on', () => {
    expect(closure).not.toContain('apps/web')
  })
})

describe('affectsDockerBuild answers for a change set', () => {
  it('is true for a source file inside a closure package', () => {
    expect(affectsDockerBuild(['packages/model/src/spatial.ts'], closure)).toBe(true)
  })

  it('is true for any workspace manifest, closure or not', () => {
    // A frozen-lockfile install inside the image installs the WHOLE workspace,
    // so a manifest edit outside the closure can still fail the build.
    expect(affectsDockerBuild(['apps/web/package.json'], closure)).toBe(true)
  })

  it('is true for the install inputs', () => {
    expect(affectsDockerBuild(['pnpm-lock.yaml'], closure)).toBe(true)
    expect(affectsDockerBuild(['.node-version'], closure)).toBe(true)
    expect(affectsDockerBuild(['patches/some-dep.patch'], closure)).toBe(true)
    expect(affectsDockerBuild(['Dockerfile.server'], closure)).toBe(true)
    expect(affectsDockerBuild(['.dockerignore'], closure)).toBe(true)
  })

  it('is true for the workflow that runs the gate', () => {
    expect(affectsDockerBuild(['.github/workflows/ci.yml'], closure)).toBe(true)
  })

  it('is false for the change shapes the skip exists for', () => {
    expect(affectsDockerBuild(['apps/web/src/pages/BrowserIndexPage.tsx'], closure)).toBe(false)
    expect(affectsDockerBuild(['.claude/rules/dev-flow.md'], closure)).toBe(false)
    expect(affectsDockerBuild(['docs/contributing/testing.md'], closure)).toBe(false)
    expect(affectsDockerBuild(['tests/e2e/distribution/README.md'], closure)).toBe(false)
  })

  it('is true when any one path in a mixed change set affects the build', () => {
    expect(
      affectsDockerBuild(
        ['apps/web/src/pages/BrowserIndexPage.tsx', 'packages/codec/src/parse.ts'],
        closure,
      ),
    ).toBe(true)
  })

  it('is false for an empty change set', () => {
    expect(affectsDockerBuild([], closure)).toBe(false)
  })
})

describe('ci.yml gates the expensive steps on the detection output', () => {
  const ciYaml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8')
  const jobStart = ciYaml.indexOf('\n  dry-run-docker:')
  const job = jobStart === -1 ? '' : ciYaml.slice(jobStart)

  it('runs the detector in the dry-run-docker job', () => {
    expect(job).toContain('tools/checks/src/docker-build-inputs.mjs')
  })

  it('checks out enough history for the merge commit to have a first parent', () => {
    // HEAD^1 on a pull_request merge ref is the base branch tip; at depth 1 it
    // does not exist and the detector fails open, silently undoing the skip.
    expect(job).toContain('fetch-depth: 2')
  })

  it('never skips the build on a push or merge_group run', () => {
    expect(job).toContain("|| 'always'")
  })

  it('leaves the job itself unconditional so the check still reports', () => {
    const header = job.slice(0, job.indexOf('steps:'))
    expect(
      header,
      'a job-level if: would make this a skipped check, not a reporting one',
    ).not.toMatch(/^\s{4}if:/m)
  })
})

// The release-please branch is open continuously and rewritten on every push
// to main, so its CI runs are a standing cost rather than an occasional one:
// measured over the last 40 pull_request runs of ci.yml, 7 of the 31 image
// builds — 23% — were that branch.
//
// What it changes, measured from the live branch rather than assumed: version
// strings and changelog entries, in `package.json`, `CHANGELOG.md`,
// `server.json`, `gemini-extension.json`, `.release-please-manifest.json` and
// the plugin manifests. Neither can change the one question the job answers,
// "does Dockerfile.server still build" — verified on both halves it could
// have: `pnpm-lock.yaml` records no workspace package's OWN version, so a bump
// cannot fail `--frozen-lockfile`, and the image build is tsup plus the widget
// build, which read no changelog.
//
// The comparison has to be on PARSED JSON, not text. release-please rewrites
// these files with different array formatting, so the textual diff of a
// version bump also carries reflowed `keywords` and `args` arrays — noise that
// a line-based rule would read as a real change.
describe('a change that cannot alter whether the image builds', () => {
  it('treats a version-only manifest rewrite as inert, formatting and all', () => {
    const before = '{"name":"x","version":"0.0.19","keywords":["a","b"]}'
    const after = `{
  "name": "x",
  "version": "0.1.0",
  "keywords": [
    "a",
    "b"
  ]
}`
    expect(inertChange('package.json', before, after)).toBe(true)
  })

  it('reads release-please’s own manifest, whose keys are paths not "version"', () => {
    const before = '{".":"0.0.19","packages/mcp-server":"0.0.19"}'
    const after = '{".":"0.1.0","packages/mcp-server":"0.1.0"}'
    expect(inertChange('.release-please-manifest.json', before, after)).toBe(true)
  })

  it('is NOT inert when a dependency range moves', () => {
    // The case the whole rule must not swallow: a dependency bump is also a
    // semver string moving, and it can fail `pnpm install --frozen-lockfile`
    // inside the build — which is exactly what this job exists to catch.
    const before = '{"version":"1.0.0","dependencies":{"zod":"3.0.0"}}'
    const after = '{"version":"1.0.1","dependencies":{"zod":"4.0.0"}}'
    expect(inertChange('package.json', before, after)).toBe(false)
  })

  it('is NOT inert when anything else in the manifest moves', () => {
    const before = '{"version":"1.0.0","scripts":{"build":"tsup"}}'
    const after = '{"version":"1.0.1","scripts":{"build":"tsc"}}'
    expect(inertChange('package.json', before, after)).toBe(false)
  })

  it('treats a changelog as inert wherever it lives', () => {
    expect(inertChange('CHANGELOG.md', '# 0.0.19\n', '# 0.1.0\n')).toBe(true)
    expect(inertChange('packages/mcp-server/CHANGELOG.md', 'a', 'b')).toBe(true)
  })

  it('is NOT inert for a file it cannot read both sides of', () => {
    // An added or deleted file has no before side. Failing open here keeps the
    // module's existing posture: a needless build costs minutes, a skipped one
    // costs a broken Dockerfile reaching a release tag.
    expect(inertChange('package.json', null, '{"version":"0.1.0"}')).toBe(false)
    expect(inertChange('src/index.ts', 'a', 'b')).toBe(false)
    expect(inertChange('package.json', '{not json', '{"a":1}')).toBe(false)
  })

  it('lets the whole measured release diff skip the build', () => {
    const releaseDiff = [
      'package.json',
      'CHANGELOG.md',
      'server.json',
      'gemini-extension.json',
      '.release-please-manifest.json',
      'packages/mcp-server/package.json',
      'packages/mcp-server/CHANGELOG.md',
    ]
    const bump = (p: string) =>
      p.endsWith('.md')
        ? (['x', 'y'] as const)
        : p === '.release-please-manifest.json'
          ? (['{".":"0.0.19"}', '{".":"0.1.0"}'] as const)
          : (['{"version":"0.0.19"}', '{"version":"0.1.0"}'] as const)
    const remaining = releaseDiff.filter((p) => {
      const [before, after] = bump(p)
      return !inertChange(p, before, after)
    })
    expect(remaining).toEqual([])
    expect(affectsDockerBuild(remaining, ['packages/mcp-server'])).toBe(false)
  })
})

describe('a version nested inside an array element', () => {
  // Ran against the live release-please branch before believing the unit
  // cases: 8 of its 10 files came back inert and two did not. Both carry the
  // bumped version inside an ARRAY — `server.json`'s `packages[0].version` and
  // `.claude-plugin/marketplace.json`'s `plugins[0].version` — which the
  // comparison was treating as one opaque differing leaf. Every hand-written
  // case had the version at an object key, so all of them passed.
  it('descends into arrays rather than calling the whole array one difference', () => {
    const before = '{"version":"0.0.19","packages":[{"registryType":"npm","version":"0.0.19"}]}'
    const after = '{"version":"0.1.0","packages":[{"registryType":"npm","version":"0.1.0"}]}'
    expect(inertChange('server.json', before, after)).toBe(true)
  })

  it('is NOT inert when an array element changes anything else', () => {
    const before = '{"packages":[{"registryType":"npm","version":"0.0.19"}]}'
    const after = '{"packages":[{"registryType":"oci","version":"0.1.0"}]}'
    expect(inertChange('server.json', before, after)).toBe(false)
  })

  it('is NOT inert when an array gains or loses an element', () => {
    const before = '{"packages":[{"version":"0.0.19"}]}'
    const after = '{"packages":[{"version":"0.1.0"},{"version":"0.1.0"}]}'
    expect(inertChange('server.json', before, after)).toBe(false)
  })
})
