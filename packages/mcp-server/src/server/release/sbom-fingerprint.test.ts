import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildSbomSidecar,
  computeSbomInputFingerprint,
  SBOM_FINGERPRINT_INPUT_PATHS,
} from '../../../scripts/release/sbom-fingerprint.mjs'
import { sbomFingerprintSidecarSchema } from './sbom-fingerprint-schema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')

// Builds a throwaway fixture workspace with the two declared input files, so
// fingerprint tests never depend on this checkout's real lockfile/manifest.
function makeFixtureWorkspace(fileContents: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sbom-fingerprint-fixture-'))
  for (const relPath of SBOM_FINGERPRINT_INPUT_PATHS) {
    const abs = join(root, relPath)
    // Every declared input path is a single path segment in this fixture set
    // today (no nested dirs beyond packages/mcp-server), so a plain
    // writeFileSync after an explicit mkdir of the parent is enough.
    const parent = dirname(abs)
    if (parent !== root) {
      mkdirSync(parent, { recursive: true })
    }
    writeFileSync(abs, fileContents[relPath] ?? relPath)
  }
  return root
}

describe('computeSbomInputFingerprint', () => {
  it('is deterministic: repeated calls over unchanged inputs return identical digests', () => {
    const root = makeFixtureWorkspace({})
    try {
      const first = computeSbomInputFingerprint(root)
      const second = computeSbomInputFingerprint(root)
      expect(second).toEqual(first)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('changes when any tracked input file changes', () => {
    const root = makeFixtureWorkspace({})
    try {
      const before = computeSbomInputFingerprint(root)
      writeFileSync(join(root, 'pnpm-lock.yaml'), 'mutated-lockfile-content')
      const after = computeSbomInputFingerprint(root)
      expect(after['pnpm-lock.yaml']).not.toBe(before['pnpm-lock.yaml'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('completes over the real repo inputs well under a generous time budget', () => {
    const start = performance.now()
    computeSbomInputFingerprint(REPO_ROOT)
    const elapsedMs = performance.now() - start
    // An order of magnitude above the expected single-digit-ms cost — a
    // canary for a future regression (e.g. hashing the whole node_modules
    // tree), not a tight microbenchmark.
    expect(elapsedMs).toBeLessThan(500)
  })
})

describe('buildSbomSidecar / schema conformance', () => {
  it('every sidecar the writer can produce parses cleanly through the shared schema', () => {
    const root = makeFixtureWorkspace({})
    try {
      const inputs = computeSbomInputFingerprint(root)
      const sidecar = buildSbomSidecar(inputs, Buffer.from('fake-sbom-bytes'))
      expect(() => sbomFingerprintSidecarSchema.parse(sidecar)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-generating from the same fingerprint and bytes is idempotent', () => {
    const inputs = {
      'pnpm-lock.yaml': 'a'.repeat(64),
      'packages/mcp-server/package.json': 'b'.repeat(64),
    }
    const bytes = Buffer.from('stable-bytes')
    expect(buildSbomSidecar(inputs, bytes)).toEqual(buildSbomSidecar(inputs, bytes))
  })
})

describe('no-subprocess static guard', () => {
  const sources = [
    join(__dirname, '../../../scripts/release/sbom-fingerprint.mjs'),
    join(__dirname, 'sbom-artifact-state.ts'),
  ]

  it('neither module imports node:child_process or spawns a subprocess', () => {
    for (const path of sources) {
      const src = readFileSync(path, 'utf-8')
      expect(src, `${path} must not import child_process`).not.toMatch(
        /from\s+['"](node:)?child_process['"]/,
      )
      expect(src, `${path} must not spawn a subprocess`).not.toMatch(
        /\b(spawnSync|spawn|execSync|execFileSync|execFile|exec|fork)\s*\(/,
      )
    }
  })
})
