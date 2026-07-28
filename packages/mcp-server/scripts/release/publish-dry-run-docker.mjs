#!/usr/bin/env node
// Dry-run Docker image preparation: build (no push) + image ID capture +
// SBOM/provenance/signing placeholders. Does NOT push to any registry.
// No cosign, no OIDC material, no registry credentials used.
// Output: structured JSON summary to stdout on success; generic message to
// stderr and exit 1 on failure. Full build logs never reach stdout.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
// In GitHub Actions, build through buildx with the GHA cache backend so the
// dependency-install and compile layers survive between runs (the plain
// `docker build` engine and the ACTIONS_CACHE_URL credentials it needs are
// only available inside a runner, not on a local dev machine).
// Read NODE_VERSION from .node-version (single source of truth).
const nodeVersion = readFileSync(join(REPO_ROOT, '.node-version'), 'utf-8').trim()

const isGitHubActions = process.env.GITHUB_ACTIONS === 'true'
const buildArgs = isGitHubActions
  ? [
      'buildx',
      'build',
      '--cache-from',
      'type=gha',
      '--cache-to',
      'type=gha,mode=max',
      '--load',
      '--build-arg',
      `NODE_VERSION=${nodeVersion}`,
      '-f',
      DOCKERFILE,
      '-t',
      IMAGE_TAG,
      '--progress=plain',
      '.',
    ]
  : [
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
}
writeFileSync(join(OUT_DIR, 'docker-image-metadata.json'), JSON.stringify(metadata, null, 2))

// Safe stdout summary: no build logs, no registry credentials, no OIDC material.
process.stdout.write(
  JSON.stringify(
    {
      schemaVersion: 1,
      ok: true,
      operation: 'publish:dry-run:docker',
      artifactId: 'docker-image',
      imageTag: IMAGE_TAG,
      imageIdLength: imageId.length,
      sbomStatus: 'deferred',
      signingStatus: 'deferred',
      note: 'no registry push; no cosign signing; publish-workflow slice required',
    },
    null,
    2,
  ) + '\n',
)
