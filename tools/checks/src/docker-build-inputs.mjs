// @whiteboard/checks — does a diff reach what the server image compiles?
//
// `dry-run-docker` is the most expensive job in ci.yml (207s of image build
// inside a 260-410s job), and it answers exactly one question: does
// Dockerfile.server still build? A pull request that cannot change the
// answer should not pay for it.
//
// The set of paths that CAN change the answer is DERIVED, not listed. The
// Dockerfile compiles a fixed pair of workspace packages; this module walks
// their `workspace:` dependency closure from the manifests and treats that
// closure — plus the install inputs — as the affecting set. Adding a package
// to the closure therefore needs no edit here, and REMOVING one cannot leave
// a stale directory behind claiming to matter.
//
// tools/checks stays dependency-free (see release-gate-matrix-schema.mjs), so
// the manifest walk is plain JSON reads.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Root-level files reach the build unconditionally: `COPY . .` puts the root
// tsconfigs, .npmrc and the lockfile into the context, and the install stage
// reads them. Cheap to over-include — measured over 40 main commits, folding
// every root-level file in rather than enumerating the load-bearing ones cost
// one additional non-skippable commit.
const ROOT_LEVEL_FILE = /^[^/]+$/
const ALWAYS_AFFECTING = [
  ROOT_LEVEL_FILE,
  // patchedDependencies are resolved by `pnpm fetch`, so a patch edit changes
  // the install even though no manifest mentions the file.
  /^patches\//,
  // Any workspace manifest: `pnpm install --frozen-lockfile` installs the
  // WHOLE workspace inside the image, so a manifest edit anywhere can fail it
  // — including in a package outside the compile closure.
  /(^|\/)package\.json$/,
  // The workflow that runs the gate.
  /^\.github\/workflows\/ci\.yml$/,
]

/**
 * The `pnpm --filter <pkg> <script>` targets Dockerfile.server builds, read
 * out of the Dockerfile itself. Remembering this pair is how it goes stale:
 * a third build line added to the Dockerfile would widen what the image
 * compiles while every hand-written list kept saying otherwise.
 * @param {string} dockerfileText
 * @returns {string[]} package names, in file order, deduped
 */
export function dockerBuildTargets(dockerfileText) {
  const targets = []
  for (const line of dockerfileText.split('\n')) {
    if (!/^RUN\s+pnpm\s/.test(line.trim())) continue
    const match = line.match(/--filter\s+(\S+)/)
    if (match && !targets.includes(match[1])) targets.push(match[1])
  }
  return targets
}

/**
 * Workspace `dependencies` closure of the given package names.
 * @param {string[]} roots package names
 * @param {Map<string, { dir: string, manifest: Record<string, unknown> }>} byName
 * @returns {string[]} repo-relative package directories, sorted
 */
export function workspaceClosure(roots, byName) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = /** @type {string} */ (queue.pop())
    if (seen.has(name) || !byName.has(name)) continue
    seen.add(name)
    const manifest = /** @type {Record<string, Record<string, string>>} */ (
      /** @type {unknown} */ (byName.get(name)?.manifest ?? {})
    )
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (typeof range === 'string' && range.startsWith('workspace:')) queue.push(dep)
      }
    }
  }
  return [...seen]
    .map((name) => byName.get(name)?.dir)
    .filter((dir) => typeof dir === 'string' && dir.length > 0)
    .sort()
}

/**
 * Build the name → { dir, manifest } index from repo-relative manifest paths.
 * @param {string} repoRoot
 * @param {string[]} manifestPaths repo-relative paths to package.json files
 */
export function indexManifests(repoRoot, manifestPaths) {
  /** @type {Map<string, { dir: string, manifest: Record<string, unknown> }>} */
  const byName = new Map()
  for (const relPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, relPath), 'utf-8'))
    if (typeof manifest.name !== 'string') continue
    byName.set(manifest.name, { dir: relPath.replace(/\/?package\.json$/, ''), manifest })
  }
  return byName
}

/**
 * @param {string[]} changedPaths repo-relative paths changed by the diff
 * @param {string[]} closureDirs from workspaceClosure()
 * @returns {boolean} true when the diff can change whether the image builds
 */
export function affectsDockerBuild(changedPaths, closureDirs) {
  return changedPaths.some((path) => {
    if (ALWAYS_AFFECTING.some((re) => re.test(path))) return true
    return closureDirs.some((dir) => path === dir || path.startsWith(`${dir}/`))
  })
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Usage: node tools/checks/src/docker-build-inputs.mjs <base-ref|always>
//
// Prints `true` or `false` on stdout, and appends `docker=<value>` to
// $GITHUB_OUTPUT when set. The literal `always` skips detection entirely —
// what a push to main and a merge_group run pass, since neither has a PR base
// to diff against and both are the last chance before a release tag.
//
// Fails OPEN: any error resolving the diff prints `true`, because the cost of
// a needless image build is minutes and the cost of a silently skipped one is
// a broken Dockerfile reaching a release tag.

if (process.argv[1]?.endsWith('docker-build-inputs.mjs')) {
  const { execFileSync } = await import('node:child_process')
  const { appendFileSync } = await import('node:fs')

  let answer = true
  let why = 'diff could not be resolved; failing open'
  try {
    const baseRef = process.argv[2]
    if (!baseRef) throw new Error('missing <base-ref> argument')
    if (baseRef === 'always') {
      answer = true
      why = 'no PR base to diff against'
      throw { handled: true }
    }
    const repoRoot = process.cwd()
    const git = (args) => execFileSync('git', args, { encoding: 'utf-8' }).trim()
    const changed = git(['diff', '--name-only', `${baseRef}...HEAD`])
      .split('\n')
      .filter(Boolean)
    const manifests = git(['ls-files', 'package.json', '*/package.json'])
      .split('\n')
      .filter((p) => p.length > 0 && !p.includes('node_modules/'))
    const targets = dockerBuildTargets(readFileSync(join(repoRoot, 'Dockerfile.server'), 'utf-8'))
    if (targets.length === 0) throw new Error('Dockerfile.server declares no pnpm --filter build')
    const closure = workspaceClosure(targets, indexManifests(repoRoot, manifests))
    answer = affectsDockerBuild(changed, closure)
    why = `${changed.length} changed path(s) against ${closure.length} closure package(s)`
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'handled' in error)) {
      answer = true
      why = `${why}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  process.stderr.write(`[docker-build-inputs] docker=${answer} (${why})\n`)
  process.stdout.write(`${answer}\n`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `docker=${answer}\n`)
  }
}
