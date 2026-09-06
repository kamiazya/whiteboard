#!/usr/bin/env node

// Dry-run Docker image preparation: build (no push) + image ID capture +
// SBOM/provenance/signing placeholders. Does NOT push to any registry.
// No cosign, no OIDC material, no registry credentials used.
// Output: structured JSON summary to stdout on success; generic message to
// stderr and exit 1 on failure. Full build logs never reach stdout.
//
// A CACHE REPORT does reach stderr, and its counts reach stdout. The build is
// the longest step in ci.yml's dry-run-docker job — around 200s of it — and
// what that time buys was unanswerable until this report existed, because the
// output below was captured and printed only on FAILURE: every green run threw
// the evidence away. It is what measured the layer cache into and back out of
// this file; see the note above the build arguments.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatCacheReport, parseBuildxProgress } from './buildx-progress.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '../..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..')
const OUT_DIR = join(PACKAGE_ROOT, 'tmp', 'publish-dry-run')
const DOCKERFILE = 'Dockerfile.server'
const IMAGE_TAG = 'whiteboard-server:dry-run'

function fail(step) {
  process.stderr.write(`[publish-dry-run:docker] failed at step: ${step}\n`)
  process.exit(1)
}

// Gracefully skip when Docker daemon is not available (CI without Docker runner).
const dockerCheck = spawnSync('docker', ['info'], {
  stdio: ['ignore', 'ignore', 'ignore'],
})
if (dockerCheck.status !== 0 || dockerCheck.error) {
  process.stderr.write('[publish-dry-run:docker] Docker daemon not available; skipping dry-run.\n')
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })

// Step 1: docker build (no push). Build logs go to the pipe but are not
// forwarded to stdout — only the safe JSON summary is printed.
//
// NO LAYER CACHE, and that is a measured decision rather than an omission.
// `--cache-from/--cache-to type=gha` was configured here, found to be doing
// nothing (the runner gives a `run:` step none of the variables the backend
// falls back to), given those variables through a local action, and then
// removed — because with the cache actually working the job got slower:
//
//   no cache            203.0s
//   cold, exporting     406.1s   (export 208.6s)
//   5/15 cached         482.7s   (export 273.6s)
//
// The export grew as the cache filled, and `[build 1/5] COPY . .` puts every
// expensive stage behind the build context, which any source change
// invalidates — and a source change in the compile closure is the only reason
// this job runs at all. What stays cacheable across real runs is the base
// stage and `pnpm fetch`, measured together at about 25s, against an export
// measured at 208-274s.
//
// Re-adding it needs a new measurement, not this comment reversed: the thing
// to change first is the 90s `--load` and the size of what mode=max exports,
// not the credentials.
// Read NODE_VERSION from .node-version (single source of truth).
const nodeVersion = readFileSync(join(REPO_ROOT, '.node-version'), 'utf-8').trim()

const buildArgs = [
  'build',
  '--build-arg',
  `NODE_VERSION=${nodeVersion}`,
  '-f',
  DOCKERFILE,
  '-t',
  IMAGE_TAG,
  '--progress=plain',
  '.',
]

const buildStartedAt = Date.now()
const buildResult = spawnSync('docker', buildArgs, {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (buildResult.status !== 0 || buildResult.error) {
  if (buildResult.stderr) {
    process.stderr.write(buildResult.stderr)
  }
  fail('docker build')
}

// The build succeeded, so report what the cache did. `--progress=plain` is
// already on both build paths above; buildx writes it to stderr.
// Wall clock, kept apart from the summed step time: BuildKit runs steps in
// parallel, so the sum is the total WORK and this is the wait. Measured on the
// first real report, 214.4s of step time inside a 200s build.
const elapsedSeconds = Number(((Date.now() - buildStartedAt) / 1000).toFixed(1))
const cacheReport = parseBuildxProgress(buildResult.stderr ?? '')
for (const line of formatCacheReport(cacheReport, { elapsedSeconds, cacheBackend: 'none' })) {
  process.stderr.write(`${line}\n`)
}
// The raw output stays available for the case the report cannot explain, but
// behind a flag: it is long, and the point of the report is to make reading it
// unnecessary.
if (process.env.WHITEBOARD_DOCKER_BUILD_LOG === '1' && buildResult.stderr) {
  process.stderr.write(buildResult.stderr)
}

// Step 2: capture locally-built image ID (sha256 digest of the image config).
// RepoDigests are only populated after a registry push; use .Id for local builds.
const inspectResult = spawnSync('docker', ['image', 'inspect', IMAGE_TAG, '--format', '{{.Id}}'], {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (inspectResult.status !== 0 || inspectResult.error) {
  fail('docker image inspect')
}

const imageId = inspectResult.stdout.trim()

// Step 3: write metadata placeholder for the publish-workflow slice.
const metadata = {
  schemaVersion: 1,
  artifactId: 'docker-image',
  imageTag: IMAGE_TAG,
  imageId,
  registryDigest: 'deferred',
  sbomStatus: 'deferred',
  signingStatus: 'deferred',
  note: 'No registry push. SBOM (docker buildx --sbom=true) and cosign keyless signing deferred to publish-workflow slice.',
  // Full report, step names included: this file is an artifact of the same run
  // whose log already names them, and trending the slowest steps across runs is
  // what turns "the build is slow" into a specific layer.
  cache: { ...cacheReport, elapsedSeconds },
}
writeFileSync(join(OUT_DIR, 'docker-image-metadata.json'), JSON.stringify(metadata, null, 2))

// Safe stdout summary: no build logs, no registry credentials, no OIDC material.
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      ok: true,
      operation: 'publish:dry-run:docker',
      artifactId: 'docker-image',
      imageTag: IMAGE_TAG,
      imageIdLength: imageId.length,
      // Counts and flags only. Step names and buildx's own diagnostics stay
      // out of stdout, which this script promises carries no build log; both
      // are in the stderr report and the metadata artifact instead.
      cache: {
        parsed: cacheReport.parsed,
        stepCount: cacheReport.stepCount,
        cachedCount: cacheReport.cachedCount,
        ranCount: cacheReport.ranCount,
        cacheHitRatio: cacheReport.cacheHitRatio,
        executedStepSeconds: cacheReport.executedStepSeconds,
        elapsedSeconds,
      },
      sbomStatus: 'deferred',
      signingStatus: 'deferred',
      note: 'no registry push; no cosign signing; publish-workflow slice required',
    },
    null,
    2,
  )}\n`,
)
