#!/usr/bin/env node
// Generates a CycloneDX SBOM for @kamiazya/whiteboard-mcp (production deps only).
// Called from workspace root: node packages/mcp-server/scripts/release/generate-npm-sbom.mjs
//
// Tool choice: @cyclonedx/cyclonedx-npm (workspace devDependency, lockfile-pinned)
//   - Pure Node.js; no binary installation required in CI.
//   - CycloneDX format aligns with supply-chain-policy.json signingStrategy.
//   - Version fixed via pnpm lockfile — deterministic per build.
//
// Lockfile binding: uses `pnpm deploy --prod` from the workspace root so that
//   production dependencies are resolved at exact versions from pnpm-lock.yaml,
//   matching the dependency graph validated by check:release-candidate.
//   Avoids re-resolving ^ / ~ ranges independently at SBOM generation time.
//   dist/ is not required — pnpm deploy uses npm-packlist and skips absent files.
//   This script runs before `pnpm test` in check:release-candidate so that the
//   SBOM content regression tests in sbom-policy.test.ts always execute.
//
// Output: packages/mcp-server/_artifacts/npm-sbom.cdx.json
//
// Safe stdout contract (JSON on success):
//   ok, operation, artifactId, sbomFile (basename), sbomBytes,
//   checksum (SHA-512), tool, toolVersion, sbomFormat, specVersion
// Not emitted: SBOM contents, dependency names, package paths,
//   registry auth, OIDC material, full build logs.
//
// On failure: generic message to stderr + exit 1.
//   Error context: step name, exit code, stdout/stderr byte lengths only.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '../..')
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const OUT_DIR = join(PACKAGE_ROOT, '_artifacts')
const SBOM_FILE = join(OUT_DIR, 'npm-sbom.cdx.json')
const TMP_DIR = join(OUT_DIR, 'sbom-npm-tmp')

function fail(step, hint) {
  process.stderr.write(`[generate-npm-sbom] failed at step: ${step}${hint ? ` — ${hint}` : ''}\n`)
  process.exit(1)
}

function safeHint(result) {
  if (result.error) return `spawn error: ${result.error.code ?? 'unknown'}`
  return `exit ${result.status}, stdoutBytes=${result.stdout?.length ?? 0}, stderrBytes=${result.stderr?.length ?? 0}`
}

// Ensure output directory exists; clean up any previous temp dir.
// pnpm deploy creates TMP_DIR itself — do not mkdir it here.
mkdirSync(OUT_DIR, { recursive: true })
try {
  rmSync(TMP_DIR, { recursive: true, force: true })
} catch {
  /* ok */
}

// Deploy production-only dependencies into an isolated temp directory.
// pnpm deploy reads pnpm-lock.yaml from the workspace root so dependency
// versions are pinned to the same graph that check:release-candidate validated,
// not re-resolved from ^ / ~ ranges at generation time.
// --ignore-scripts: no lifecycle scripts needed for SBOM generation.
const deployResult = spawnSync(
  'pnpm',
  [
    '--filter',
    '@kamiazya/whiteboard-mcp',
    'deploy',
    '--legacy',
    '--prod',
    '--ignore-scripts',
    TMP_DIR,
  ],
  {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

if (deployResult.status !== 0 || deployResult.error) {
  rmSync(TMP_DIR, { recursive: true, force: true })
  fail('pnpm-deploy-production', safeHint(deployResult))
}

// Use the lockfile-pinned binary from the workspace.
const cyclonedxBin = resolve(WORKSPACE_ROOT, 'node_modules', '.bin', 'cyclonedx-npm')

// Strip package-manager lifecycle env before invoking cyclonedx-npm.
// Under `pnpm run`, npm_execpath points at pnpm's own CLI; cyclonedx-npm uses
// npm_execpath to locate "npm", so it would silently run `pnpm ls` instead of
// `npm ls` and die with an option-parse error (exit 254, empty stdout).
// Compare case-insensitively: Windows env var keys are case-insensitive and
// may surface with different casing than the lowercase names pnpm sets.
const cleanEnv = { ...process.env }
for (const key of Object.keys(cleanEnv)) {
  const lowerKey = key.toLowerCase()
  if (
    lowerKey === 'npm_execpath' ||
    lowerKey.startsWith('npm_config_') ||
    lowerKey.startsWith('npm_lifecycle_')
  ) {
    delete cleanEnv[key]
  }
}

// Generate the SBOM from the isolated production deploy.
// --ignore-npm-errors: npm ls reports ELSPROBLEMS for devDependencies listed
//   in package.json but absent from node_modules (deployed prod-only).
//   The node_modules was installed from pnpm-lock.yaml so the SBOM is
//   lockfile-bound despite the npm ls complaint.
const sbomResult = spawnSync(
  cyclonedxBin,
  [
    '--ignore-npm-errors',
    '--output-format',
    'JSON',
    '--output-file',
    SBOM_FILE,
    '--output-reproducible', // omit timestamps for deterministic output
    '--spec-version',
    '1.4', // CycloneDX 1.4 — stable spec
  ],
  {
    cwd: TMP_DIR,
    env: cleanEnv,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'], // never relay tool output to our stdout
  },
)

// Clean up temp dir regardless of outcome.
rmSync(TMP_DIR, { recursive: true, force: true })

if (sbomResult.status !== 0 || sbomResult.error) {
  fail('cyclonedx-npm', safeHint(sbomResult))
}

// Verify the output file was written and is non-empty.
let sbomBytes
try {
  sbomBytes = readFileSync(SBOM_FILE)
} catch {
  fail('sbom-file-read')
}

if (sbomBytes.length === 0) {
  fail('sbom-file-empty', 'cyclonedx-npm wrote an empty file')
}

const sha512Hex = createHash('sha512').update(sbomBytes).digest('hex')

// Extract tool version from SBOM metadata — schema-level field, not dep content.
let toolVersion = 'unknown'
try {
  const sbomJson = JSON.parse(sbomBytes.toString('utf-8'))
  const tools = sbomJson?.metadata?.tools
  if (Array.isArray(tools)) {
    const cdxTool = tools.find((t) => t.name === 'cyclonedx-npm')
    if (cdxTool?.version) toolVersion = String(cdxTool.version)
  }
} catch {
  // Non-fatal: version extraction does not affect SBOM file validity.
}

// Safe stdout summary only — no SBOM contents, dep names, or paths.
process.stdout.write(
  JSON.stringify(
    {
      schemaVersion: 1,
      ok: true,
      operation: 'generate:sbom:npm',
      artifactId: 'npm-tarball',
      sbomFile: basename(SBOM_FILE),
      sbomFormat: 'CycloneDX/JSON',
      specVersion: '1.4',
      sbomBytes: sbomBytes.length,
      checksum: { algorithm: 'SHA-512', hex: sha512Hex },
      tool: '@cyclonedx/cyclonedx-npm',
      toolVersion,
    },
    null,
    2,
  ) + '\n',
)
