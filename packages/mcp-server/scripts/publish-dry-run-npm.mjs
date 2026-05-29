#!/usr/bin/env node
// Dry-run npm tarball preparation: pnpm pack + SHA-512 checksum capture +
// SBOM placeholder. Does NOT publish to any registry.
// No NPM_TOKEN, no --provenance flag, no OIDC material used.
// Output: structured JSON summary to stdout on success; generic message to
// stderr and exit 1 on failure. Full tarball contents never reach stdout.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '..')
const OUT_DIR = join(PACKAGE_ROOT, 'tmp', 'publish-dry-run')

function fail(step) {
  process.stderr.write(`[publish-dry-run:npm] failed at step: ${step}\n`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

// Step 1: pnpm pack → tarball lands in OUT_DIR
const packResult = spawnSync('pnpm', ['pack', '--pack-destination', OUT_DIR], {
  cwd: PACKAGE_ROOT,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (packResult.status !== 0 || packResult.error) {
  fail('pnpm pack')
}

// pnpm pack prints the tarball path on the last non-empty stdout line.
// It may be a full absolute path or just a basename depending on the pnpm
// version — resolve against OUT_DIR in both cases since that is where
// --pack-destination writes the file.
const rawPackOutput = packResult.stdout
  .trim()
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .pop()

if (!rawPackOutput) {
  fail('pnpm pack output parse')
}

const tarballName = basename(rawPackOutput)
const tarballAbsPath = isAbsolute(rawPackOutput)
  ? rawPackOutput
  : resolve(OUT_DIR, tarballName)

// Step 2: SHA-512 checksum (computed in-process to avoid subprocess output leaking)
let tarballBytes
try {
  tarballBytes = readFileSync(tarballAbsPath)
} catch {
  fail('tarball read for checksum')
}

const checksumHex = createHash('sha512').update(tarballBytes).digest('hex')
// shasum-compatible format: "<hex>  <filename>"
writeFileSync(join(OUT_DIR, 'npm-tarball.sha512'), `${checksumHex}  ${tarballName}\n`)

// Step 3: SBOM reference — real generation runs in publish-production.yml via
// `pnpm generate:sbom:npm` (packages/mcp-server/scripts/generate-npm-sbom.mjs).
// Dry-run intentionally skips SBOM generation: it does not build the artifact,
// so there is nothing to attach a SBOM to. The placeholder records the policy.
const sbomPlaceholder = {
  schemaVersion: 1,
  status: 'skipped-dry-run',
  artifactId: 'npm-tarball',
  note: 'SBOM generation runs in publish-production.yml before npm publish; see generate-npm-sbom.mjs',
  tool: '@cyclonedx/cyclonedx-npm',
}
writeFileSync(
  join(OUT_DIR, 'npm-tarball.sbom.placeholder.json'),
  JSON.stringify(sbomPlaceholder, null, 2),
)

// Safe stdout summary: no tarball file contents, no package internals,
// no registry auth, no OIDC material.
process.stdout.write(
  JSON.stringify(
    {
      schemaVersion: 1,
      ok: true,
      operation: 'publish:dry-run:npm',
      artifactId: 'npm-tarball',
      tarball: tarballName,
      fileSizeBytes: tarballBytes.length,
      checksum: { algorithm: 'SHA-512', hex: checksumHex },
      sbomStatus: 'deferred',
      note: 'no registry publish; no OIDC provenance; publish-workflow slice required',
    },
    null,
    2,
  ) + '\n',
)
