// Contract tests for the Diataxis docs IA.
//
// They assert the canonical paths after the docs reorganisation and guard
// against stale links back to the old paths.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
    expect(existsSync(resolve(repoRoot, 'docs/contributing/architecture/wire-protocol.md'))).toBe(
      true,
    )
  })

  // The only one of the moved pages that is now gone rather than relocated: it
  // documented `template_insert`, `annotate_batch` and `box_with_label`, none of
  // which are registered tools any more. Asserting its absence keeps the
  // deletion deliberate — a page describing removed tools must not reappear.
  it('docs/reference/templates.md does not exist (its tools were removed)', () => {
    expect(existsSync(resolve(repoRoot, 'docs/reference/templates.md'))).toBe(false)
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
  // CONTRIBUTING.md, or AGENTS.md. Catches the absolute-style docs/<name>.md
  // and traversal forms like ../../docs/<name>.md. Plain ../<name>.md is not
  // flagged here because its resolution is depth-dependent; those are caught
  // by the "stub does not exist" tests above.
  it('no stale refs to moved doc paths remain across all docs and root files', () => {
    const docsDir = resolve(repoRoot, 'docs')
    const docFiles = existsSync(docsDir) ? walkMd(docsDir, repoRoot) : []
    const rootFiles = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md']
    const filesToCheck = [...docFiles, ...rootFiles]

    // Matches references that unambiguously point to the old root-level stubs
    // at docs/<name>.md — both the literal path and relative forms like
    // ../../docs/<name>.md. A plain ../<name>.md is omitted because its
    // resolution depends on the linking file's depth; such links are validated
    // by the "stub does not exist" tests above instead.
    const oldPathPattern =
      /(?:(?:\.\.\/)*|\/)docs\/(architecture|templates|pages-deploy-mvp|wire-protocol|testing|docker-server|configuration|observability|security-model|mcp-debugging|development)\.md/g

    for (const relPath of filesToCheck) {
      if (!existsSync(resolve(repoRoot, relPath))) continue
      const matches = readText(relPath).match(oldPathPattern)
      expect(
        matches,
        `${relPath} still contains stale path refs: ${matches?.join(', ')}`,
      ).toBeNull()
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
    expect(
      existsSync(resolve(repoRoot, 'docs/contributing/adr/0001-apps-web-canonical-frontend.md')),
    ).toBe(true)
  })

  it('docs/contributing/adr/0002-browser-to-daemon-transport.md exists', () => {
    expect(
      existsSync(resolve(repoRoot, 'docs/contributing/adr/0002-browser-to-daemon-transport.md')),
    ).toBe(true)
  })

  it('docs/contributing/adr/0003-track-claude-dev-flow-tooling.md exists', () => {
    expect(
      existsSync(resolve(repoRoot, 'docs/contributing/adr/0003-track-claude-dev-flow-tooling.md')),
    ).toBe(true)
  })

  // docs/contributing/README.md must point to adr/ and must not imply ADRs live under architecture/.
  it('docs/contributing/README.md contains adr/ link', () => {
    const content = readText('docs/contributing/README.md')
    expect(content).toContain('adr/')
  })

  it('docs/contributing/README.md architecture/ bullet does not claim ADRs live there', () => {
    const content = readText('docs/contributing/README.md')
    // Find the architecture/ bullet line and assert it does not contain 'ADRs'
    const archLine = content.split('\n').find((line) => line.includes('**architecture/**'))
    expect(archLine).toBeDefined()
    expect(archLine).not.toContain('ADRs')
  })
})

// GitHub's heading-anchor slug: lowercase, drop everything that is not a
// word character, space or hyphen, then hyphenate the spaces. Inline markdown
// (backticks, emphasis, links) contributes only its visible text.
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>()
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (!heading) continue
    const slug = heading[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s/g, '-')
    anchors.add(slug)
  }
  return anchors
}

describe('docs anchor links', () => {
  // A cross-file `#anchor` breaks silently: the link still renders, still
  // clicks, and lands the reader at the top of a page that no longer has the
  // section. Four README links pointed at a `#bundled-skills-install` section
  // that had been deliberately deleted, and nothing noticed.
  it('every cross-file markdown anchor link resolves to a real heading', () => {
    const docsDir = resolve(repoRoot, 'docs')
    const files = [
      ...(existsSync(docsDir) ? walkMd(docsDir, repoRoot) : []),
      'README.md',
      'CONTRIBUTING.md',
      'AGENTS.md',
    ].filter((relPath) => existsSync(resolve(repoRoot, relPath)))

    const anchorsByFile = new Map<string, Set<string>>()
    const broken: string[] = []

    for (const relPath of files) {
      for (const link of readText(relPath).matchAll(/\]\((?!https?:)([^)\s#]+)#([^)\s]+)\)/g)) {
        const target = resolve(repoRoot, dirname(relPath), link[1])
        if (!target.endsWith('.md') || !existsSync(target)) continue
        let anchors = anchorsByFile.get(target)
        if (!anchors) {
          anchors = headingAnchors(readFileSync(target, 'utf-8'))
          anchorsByFile.set(target, anchors)
        }
        if (!anchors.has(link[2])) {
          broken.push(`${relPath} -> ${link[1]}#${link[2]}`)
        }
      }
    }

    expect(broken).toEqual([])
  })
})
