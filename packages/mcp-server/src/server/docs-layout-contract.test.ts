// Contract tests for the Diataxis docs IA.
//
// They assert the canonical paths after the docs reorganisation and guard
// against stale links back to the old paths.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

function walkMd(dir: string, base: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walkMd(full, base, acc)
    } else if (entry.endsWith('.md')) {
      acc.push(full.slice(base.length + 1))
    }
  }
  return acc
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readText(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
}

describe('docs layout contract', () => {
  it('docs/reference/configuration.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/reference/configuration.md'))).toBe(true)
  })

  it('docs/how-to/self-host-with-docker.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/how-to/self-host-with-docker.md'))).toBe(true)
  })

  it('docs/contributing/observability.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/observability.md'))).toBe(true)
  })

  it('docs/explanation/architecture.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/explanation/architecture.md'))).toBe(true)
  })

  it('docs/explanation/security-model.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/explanation/security-model.md'))).toBe(true)
  })

  it('docs/contributing/architecture/wire-protocol.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/architecture/wire-protocol.md'))).toBe(true)
  })

  it('docs/reference/templates.md exists at the new path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/reference/templates.md'))).toBe(true)
  })

  it('docs/contributing/review-checklist.md exists', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/review-checklist.md'))).toBe(true)
  })

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

  // Each of the 11 old stub paths must not exist after removal.
  it('docs/architecture.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/architecture.md'))).toBe(false)
  })

  it('docs/templates.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/templates.md'))).toBe(false)
  })

  it('docs/pages-deploy-mvp.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/pages-deploy-mvp.md'))).toBe(false)
  })

  it('docs/wire-protocol.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/wire-protocol.md'))).toBe(false)
  })

  it('docs/testing.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/testing.md'))).toBe(false)
  })

  it('docs/docker-server.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/docker-server.md'))).toBe(false)
  })

  it('docs/configuration.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/configuration.md'))).toBe(false)
  })

  it('docs/observability.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/observability.md'))).toBe(false)
  })

  it('docs/security-model.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/security-model.md'))).toBe(false)
  })

  it('docs/mcp-debugging.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/mcp-debugging.md'))).toBe(false)
  })

  it('docs/development.md stub does not exist', () => {
    expect(existsSync(resolve(repoRoot, 'docs/development.md'))).toBe(false)
  })

  // No stale refs to any of the 11 old stub paths anywhere in docs/, README.md,
  // CONTRIBUTING.md, or AGENTS.md. The portless link was updated to the new path.
  it('no stale refs to moved doc paths remain across all docs and root files', () => {
    const docsDir = resolve(repoRoot, 'docs')
    const docFiles = existsSync(docsDir) ? walkMd(docsDir, repoRoot) : []
    const rootFiles = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md']
    const filesToCheck = [...docFiles, ...rootFiles]

    const oldPathPattern =
      /docs\/(architecture|templates|pages-deploy-mvp|wire-protocol|testing|docker-server|configuration|observability|security-model|mcp-debugging|development)\.md/g

    for (const relPath of filesToCheck) {
      if (!existsSync(resolve(repoRoot, relPath))) continue
      const matches = readText(relPath).match(oldPathPattern)
      expect(matches, `${relPath} still contains stale path refs: ${matches?.join(', ')}`).toBeNull()
    }
  })

  // ADR practice: docs/contributing/adr/ files must exist.
  it('docs/contributing/adr/README.md exists', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/adr/README.md'))).toBe(true)
  })

  it('docs/contributing/adr/template.md exists', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/adr/template.md'))).toBe(true)
  })

  it('docs/contributing/adr/0001-apps-web-canonical-frontend.md exists', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/adr/0001-apps-web-canonical-frontend.md'))).toBe(true)
  })

  it('docs/contributing/adr/0002-browser-to-daemon-transport.md exists', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/adr/0002-browser-to-daemon-transport.md'))).toBe(true)
  })

  it('docs/contributing/adr/0003-track-claude-dev-flow-tooling.md exists', () => {
    expect(existsSync(resolve(repoRoot, 'docs/contributing/adr/0003-track-claude-dev-flow-tooling.md'))).toBe(true)
  })

  // docs/contributing/README.md must point to adr/ and must not imply ADRs live under architecture/.
  it('docs/contributing/README.md contains adr/ link', () => {
    const content = readText('docs/contributing/README.md')
    expect(content).toContain('adr/')
  })

  it('docs/contributing/README.md architecture/ bullet does not claim ADRs live there', () => {
    const content = readText('docs/contributing/README.md')
    // Find the architecture/ bullet line and assert it does not contain 'ADRs'
    const archLine = content.split('\n').find(line => line.includes('**architecture/**'))
    expect(archLine).toBeDefined()
    expect(archLine).not.toContain('ADRs')
  })
})
