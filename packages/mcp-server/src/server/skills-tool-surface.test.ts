import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { ALL_REGISTERED_TOOLS } from './mcp/mcp-smoke-coverage.js'

// Same repo-root resolution as the sibling plugin-support.test.ts
// (packages/mcp-server/src/server/plugin-support.test.ts): both files sit at
// the same depth under the repo root.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')
const SKILLS_ROOT = resolve(repoRoot, 'skills')

function collectMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectMarkdownFiles(entryPath)
    return entry.name.endsWith('.md') ? [entryPath] : []
  })
}

const SKILL_FILES = collectMarkdownFiles(SKILLS_ROOT)

function readSkill(path: string): string {
  return readFileSync(path, 'utf-8')
}

function displayPath(path: string): string {
  return relative(repoRoot, path)
}

// Names outside the registered tool surface that legitimately appear
// backtick-quoted in skill prose (frontmatter keys, JSON Canvas field
// literals, etc). Keep this list small — a growing list is the signal that
// the extractor regex, not the prose, is wrong. Each entry names the file it
// covers so a stale allowlist entry is easy to spot in review.
const SNAKE_CASE_ALLOWLIST: ReadonlySet<string> = new Set([])

// Each pattern retires one confirmed piece of dead surface from the pre-rewrite
// skills (Excalidraw-era tool names, the removed /api/debug audit endpoint,
// and the PNG/raster export claims the SVG-only wb_scene_render replaced).
// A legitimate future negative mention (explaining why raster export is
// absent, say) earns a reason-commented allowlist entry here, never a
// weakened pattern — see skills-rewrite design risk #2.
const BANNED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /Excalidraw/,
    reason: 'the product is JSON Canvas + OKF Markdown over MCP tools, not Excalidraw',
  },
  {
    pattern: /\/api\/debug/,
    reason:
      'the /api/debug audit endpoint was removed; audits use wb_document_list + wb_scene_digest',
  },
  {
    pattern: /hasActivePort/,
    reason: 'hasActivePort was a field on the removed /api/debug response shape',
  },
  {
    pattern: /\bPNG\b/i,
    reason:
      'export is SVG-only via wb_scene_render (docs/reference/export-formats.md); there is no raster export tool',
  },
  {
    pattern: /\braster\b/i,
    reason:
      'export is SVG-only via wb_scene_render (docs/reference/export-formats.md); there is no raster export tool',
  },
  // The seven single-purpose spatial-mutation tools, retired into
  // wb_canvas_edit's op list (ADR-0010). Their names are banned outright
  // rather than left to the registered-tool check below, so prose that
  // teaches the old one-call-per-edit shape fails loudly instead of only
  // failing once someone notices the tool is gone.
  {
    pattern: /\bwb_node_add\b/,
    reason: 'retired into wb_canvas_edit — use an ops entry { op: "node.add" }',
  },
  {
    pattern: /\bwb_node_patch\b/,
    reason: 'retired into wb_canvas_edit — use an ops entry { op: "node.patch" }',
  },
  {
    pattern: /\bwb_edge_add\b/,
    reason: 'retired into wb_canvas_edit — use an ops entry { op: "edge.add" }',
  },
  {
    pattern: /\bwb_edge_patch\b/,
    reason: 'retired into wb_canvas_edit — use an ops entry { op: "edge.patch" }',
  },
  {
    pattern: /\bwb_node_lock\b/,
    reason: 'retired into wb_canvas_edit — use an ops entry { op: "node.lock" }',
  },
  {
    pattern: /\bwb_edge_lock\b/,
    reason: 'retired into wb_canvas_edit — use an ops entry { op: "edge.lock" }',
  },
  {
    pattern: /\bwb_canvas_tidy\b/,
    reason: 'retired into wb_canvas_edit — use an ops entry { op: "tidy" }',
  },
]

describe('skills tool-surface guard', () => {
  // Non-vacuity: a glob or regex that silently stops matching must fail
  // loudly rather than let every other assertion below pass on zero input.
  it('finds at least three SKILL.md files under skills/', () => {
    const skillMdFiles = SKILL_FILES.filter((path) => path.endsWith('SKILL.md'))
    expect(skillMdFiles.length).toBeGreaterThanOrEqual(3)
  })

  it('mentions at least one registered tool across skills/', () => {
    const totalMentions = SKILL_FILES.reduce((count, path) => {
      const matches = readSkill(path).match(/\bwb_[a-z_]+\b/g) ?? []
      return count + matches.length
    }, 0)
    expect(totalMentions).toBeGreaterThan(0)
  })

  it('every wb_-prefixed token in skills/**/*.md is a registered tool', () => {
    const offenders: string[] = []
    for (const path of SKILL_FILES) {
      const matches = readSkill(path).match(/\bwb_[a-z_]+\b/g) ?? []
      for (const token of new Set(matches)) {
        if (!(ALL_REGISTERED_TOOLS as readonly string[]).includes(token)) {
          offenders.push(`${displayPath(path)}: ${token}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every canvas_-prefixed token in skills/**/*.md is a registered tool', () => {
    const offenders: string[] = []
    for (const path of SKILL_FILES) {
      const matches = readSkill(path).match(/\bcanvas_[a-z_]+\b/g) ?? []
      for (const token of new Set(matches)) {
        if (!(ALL_REGISTERED_TOOLS as readonly string[]).includes(token)) {
          offenders.push(`${displayPath(path)}: ${token}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every backtick-quoted snake_case token is a registered tool or on the allowlist', () => {
    const offenders: string[] = []
    for (const path of SKILL_FILES) {
      const content = readSkill(path)
      const backticked = content.match(/`[^`\n]+`/g) ?? []
      for (const span of backticked) {
        const inner = span.slice(1, -1)
        const tokens = inner.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []
        for (const token of new Set(tokens)) {
          if (
            !(ALL_REGISTERED_TOOLS as readonly string[]).includes(token) &&
            !SNAKE_CASE_ALLOWLIST.has(token)
          ) {
            offenders.push(`${displayPath(path)}: ${token}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('contains none of the banned dead-surface patterns', () => {
    const hits: string[] = []
    for (const path of SKILL_FILES) {
      const lines = readSkill(path).split('\n')
      lines.forEach((line, index) => {
        for (const { pattern, reason } of BANNED_PATTERNS) {
          if (pattern.test(line)) {
            hits.push(`${displayPath(path)}:${index + 1} matches ${pattern} (${reason})`)
          }
        }
      })
    }
    expect(hits).toEqual([])
  })

  it('resolves every relative markdown link inside skills/ to an existing file', () => {
    const brokenLinks: string[] = []
    const linkPattern = /\]\(([^)]+)\)/g
    for (const path of SKILL_FILES) {
      const content = readSkill(path)
      for (const match of content.matchAll(linkPattern)) {
        const target = match[1]
        if (target === undefined) continue
        // Skip absolute URLs, mailto, and in-page anchors — only a relative
        // file path can strand a link when a reference file is deleted.
        if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
        const [withoutAnchor] = target.split('#')
        if (!withoutAnchor) continue
        const resolved = resolve(dirname(path), withoutAnchor)
        if (!existsSync(resolved)) {
          brokenLinks.push(`${displayPath(path)}: ${target}`)
        }
      }
    }
    expect(brokenLinks).toEqual([])
  })

  it('plugin manifests point at a repo-root skills/ dir carrying three named SKILL.md files', () => {
    // The repo root is the ONLY distribution point for skills: the Claude
    // Code / Codex plugin manifests resolve here, and the npm package
    // deliberately ships none — nothing in the published server reads a
    // packaged skills/ directory, so a files-array entry for it was a
    // false claim (removed 2026-08-17), not a missing copy step.
    const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8'))
    const claudePlugin = readJson(resolve(repoRoot, '.claude-plugin/plugin.json'))
    const codexPlugin = readJson(resolve(repoRoot, '.codex-plugin/plugin.json'))
    expect(claudePlugin.skills).toBe('./skills')
    expect(codexPlugin.skills).toBe('./skills')
    expect(existsSync(SKILLS_ROOT)).toBe(true)

    // Pin the deliberate ABSENCE: reintroducing 'skills' to the npm files
    // array without a consumer would revive the false shipped-skills claim.
    const mcpPackage = readJson(resolve(repoRoot, 'packages/mcp-server/package.json'))
    expect(mcpPackage.files).not.toContain('skills')

    // And the deliberate absence of a SECOND copy. `packages/mcp-server/skills/`
    // was a byte-identical duplicate of this tree, tracked but read by
    // nothing — the guard below only scans the repo root, so a sweep that
    // fixed one copy left the other stale while every assertion stayed
    // green. Deleted 2026-08-18; this keeps it deleted.
    expect(existsSync(resolve(repoRoot, 'packages/mcp-server/skills'))).toBe(false)

    const skillDirs = ['drawing-visuals', 'coauthoring-visuals', 'auditing-workspaces']
    expect(skillDirs).toHaveLength(3)
    for (const dir of skillDirs) {
      const skillMdPath = resolve(SKILLS_ROOT, dir, 'SKILL.md')
      expect(existsSync(skillMdPath), `${dir}/SKILL.md should exist`).toBe(true)
      const frontmatterMatch = readFileSync(skillMdPath, 'utf-8').match(/^---\n([\s\S]*?)\n---/)
      expect(frontmatterMatch, `${dir}/SKILL.md should start with --- frontmatter ---`).not.toBe(
        null,
      )
      const frontmatter = frontmatterMatch?.[1] ?? ''
      expect(frontmatter).toMatch(/^name:\s*\S/m)
      expect(frontmatter).toMatch(/^description:\s*\S/m)
    }
  })

  // Sanity check that the walk itself has the shape the rest of this file
  // assumes — a future rename of SKILL.md's extension would otherwise pass
  // every assertion above by finding nothing.
  it('only ever walks markdown files', () => {
    for (const path of SKILL_FILES) {
      expect(extname(path)).toBe('.md')
    }
  })
})
