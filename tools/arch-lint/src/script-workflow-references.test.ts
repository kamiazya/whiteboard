// A script's message or comment that names a workflow file is read as a pointer: "the real publish
// runs in release.yml". The pointer outlives the file it names, and nothing fails when it does —
// the dry-run release scripts kept telling CI artifact readers that SBOM generation "runs in
// publish-production.yml" after that workflow was folded into release.yml.
//
// A `.yml`/`.yaml` name in a script must therefore be a workflow that exists, or a config file that
// exists at the repo root (`pnpm-lock.yaml`, `lefthook.yml`). Test files are out of scope: they
// name fixture workflows on purpose.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo, SCRIPT_SCAN_ROOTS, walk } from './scan-roots.js'

const YAML_NAME = /[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml\b/g

/** The `.yml`/`.yaml` file names `text` mentions, path prefixes dropped. */
function yamlNames(text: string): string[] {
  return [...text.matchAll(YAML_NAME)].map((match) => match[0].split('/').pop() ?? match[0])
}

/** The names that are neither a workflow nor a root-level file. */
function unresolvedYamlNames(
  text: string,
  exists: { workflow: (name: string) => boolean; rootFile: (name: string) => boolean },
): string[] {
  return yamlNames(text).filter((name) => !exists.workflow(name) && !exists.rootFile(name))
}

const WORKFLOWS = new Set(readdirSync(join(REPO_ROOT, '.github', 'workflows')))
const exists = {
  workflow: (name: string) => WORKFLOWS.has(name),
  rootFile: (name: string) => existsSync(join(REPO_ROOT, name)),
}

const SCRIPT_FILE = /\.(mjs|js|ts|sh)$/
const isScript = (path: string) => SCRIPT_FILE.test(path) && !/\.test\.[cm]?[jt]s$/.test(path)

describe('scripts name only workflow files that exist', () => {
  const scripts = [...SCRIPT_SCAN_ROOTS, '.claude/scripts']
    .filter((dir) => existsSync(join(REPO_ROOT, dir)))
    .flatMap((dir) =>
      walk(join(REPO_ROOT, dir), {
        include: isScript,
        skip: (_path, name) => name === 'node_modules',
      }),
    )

  it('scans the release scripts that carry workflow pointers', () => {
    const scanned = scripts.map((path) => relativeToRepo(path))
    expect(scanned).toContain('packages/mcp-server/scripts/release/publish-dry-run-npm.mjs')
    expect(scanned).toContain('packages/mcp-server/scripts/release/publish-dry-run-docker.mjs')
  })

  it('finds no .yml name that is not a workflow or a root file', () => {
    const dangling = scripts.flatMap((path) =>
      unresolvedYamlNames(readFileSync(path, 'utf8'), exists).map(
        (name) => `${relativeToRepo(path)}: ${name}`,
      ),
    )
    expect(dangling).toEqual([])
  })

  it('reports a workflow that was deleted', () => {
    expect(
      unresolvedYamlNames(
        'SBOM generation runs in publish-production.yml before npm publish',
        exists,
      ),
    ).toEqual(['publish-production.yml'])
    expect(
      unresolvedYamlNames('see .github/workflows/release.yml and pnpm-lock.yaml', exists),
    ).toEqual([])
  })
})
