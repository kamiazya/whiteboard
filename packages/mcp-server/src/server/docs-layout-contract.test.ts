// Contract tests for the Diataxis docs IA.
//
// They assert the canonical paths after the docs reorganisation and guard
// against stale links back to the old paths.
//
// Stub files with "# Moved" headers at the old paths are intentionally kept as
// permanent redirects for external-link stability, so the link-audit only
// scans the curated index files below — never the stubs themselves.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readText(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
}

describe('docs layout contract', () => {
  // S1 — configuration moved to reference/
  it('docs/reference/configuration.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/reference/configuration.md'))).toBe(true)
  })

  // S2 — docker-server moved to how-to/
  it('docs/how-to/self-host-with-docker.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/how-to/self-host-with-docker.md'))).toBe(true)
  })

  // S3 — observability moved to contributing/
  it('docs/contributing/observability.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/observability.md'))).toBe(true)
  })

  // S4 — architecture moved to explanation/
  it('docs/explanation/architecture.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/explanation/architecture.md'))).toBe(true)
  })

  // S5 — security-model moved to explanation/
  it('docs/explanation/security-model.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/explanation/security-model.md'))).toBe(true)
  })

  // S6 — wire-protocol moved to contributing/architecture/
  it('docs/contributing/architecture/wire-protocol.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/architecture/wire-protocol.md'))).toBe(true)
  })

  // S7 — templates moved to reference/
  it('docs/reference/templates.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/reference/templates.md'))).toBe(true)
  })

  // S0 — review-checklist English translation exists in contributing/
  it('docs/contributing/review-checklist.md exists', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/review-checklist.md'))).toBe(true)
  })

  // S8 — OSS root files exist
  it('CODE_OF_CONDUCT.md exists at repo root', () => {
    expect(existsSync(resolve(repoRoot, 'CODE_OF_CONDUCT.md'))).toBe(true)
  })

  it('.github/PULL_REQUEST_TEMPLATE.md exists', () => {
    expect(existsSync(resolve(repoRoot, '.github/PULL_REQUEST_TEMPLATE.md'))).toBe(true)
  })

  it('.github/ISSUE_TEMPLATE/bug_report.yml exists', () => {
    expect(existsSync(resolve(repoRoot, '.github/ISSUE_TEMPLATE/bug_report.yml'))).toBe(true)
  })

  it('.github/ISSUE_TEMPLATE/feature_request.yml exists', () => {
    expect(existsSync(resolve(repoRoot, '.github/ISSUE_TEMPLATE/feature_request.yml'))).toBe(true)
  })

  // S9 — link-audit: moved doc paths must NOT appear in the curated index files.
  // The "# Moved" redirect stubs are excluded by construction (they are not listed here).
  it('no stale refs to moved doc paths remain in curated index files', () => {
    const filesToCheck = [
      'README.md',
      'CONTRIBUTING.md',
      'AGENTS.md',
      'docs/README.md',
      'docs/contributing/README.md',
      'docs/how-to/README.md',
      'docs/reference/README.md',
      'docs/explanation/README.md',
    ]

    const oldPathPattern =
      /docs\/(configuration|docker-server|observability|architecture|security-model|wire-protocol|templates)\.md/g

    for (const relPath of filesToCheck) {
      if (!existsSync(resolve(repoRoot, relPath))) continue
      const matches = readText(relPath).match(oldPathPattern)
      expect(matches, `${relPath} still contains stale path refs: ${matches?.join(', ')}`).toBeNull()
    }
  })
})
