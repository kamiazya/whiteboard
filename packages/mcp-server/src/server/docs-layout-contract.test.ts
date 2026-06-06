// Contract tests for the Diataxis docs IA.
//
// These tests assert the NEW canonical paths after the docs reorganisation and
// act as a regression guard against regressions (stale links back to old paths).
//
// Stub files with "# Moved" headers at the old paths are intentionally KEPT
// as permanent redirects for external-link stability; the link-audit check
// EXCLUDES those stub files (and docs/portless-local-dev.md, which is held
// pending a separate decision) so they do not false-positive.

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

  // S9 — link-audit: old paths must NOT appear in docs/** + key root files
  // EXCEPT inside the "# Moved" stub files themselves and portless-local-dev.md
  it('no stale refs to moved doc paths remain outside redirect stubs', () => {
    const stubFiles = new Set([
      'docs/configuration.md',
      'docs/docker-server.md',
      'docs/observability.md',
      'docs/architecture.md',
      'docs/security-model.md',
      'docs/wire-protocol.md',
      'docs/templates.md',
      // portless-local-dev.md is held at docs root pending a separate decision
      'docs/portless-local-dev.md',
    ])

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
      /docs\/(configuration|docker-server|observability|architecture|security-model|wire-protocol|templates)\.md/

    for (const relPath of filesToCheck) {
      const absPath = resolve(repoRoot, relPath)
      if (!existsSync(absPath)) continue
      const content = readText(relPath)
      const matches = content.match(new RegExp(oldPathPattern.source, 'g'))
      if (matches) {
        // Check whether any match is a redirect stub marker
        const isStub = stubFiles.has(relPath)
        if (!isStub) {
          expect(matches, `${relPath} still contains stale path refs: ${matches.join(', ')}`).toBeNull()
        }
      }
    }
  })
})
