import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { repoRoot } from '../shared/test-utils/repo-root.js'
import { ALL_REGISTERED_TOOLS } from './mcp/mcp-smoke-coverage.js'

const REPO_ROOT = repoRoot()
const SKILLS_ROOT = resolve(REPO_ROOT, 'skills')

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
  return relative(REPO_ROOT, path)
}

// Names outside the registered tool surface that legitimately appear
// backtick-quoted in skill prose (frontmatter keys, JSON Canvas field
// literals, etc). Keep this list small — a growing list is the signal that
// the extractor regex, not the prose, is wrong. Each entry names the file it
// covers so a stale allowlist entry is easy to spot in review.
const SNAKE_CASE_ALLOWLIST: ReadonlySet<string> = new Set([])

// Each pattern retires one piece of surface the pre-rewrite skills taught and
// a skill must not teach now: Excalidraw-era tool names, the dev-only
// /api/debug dump, and the PNG/raster export claims the SVG-only
// wb_scene_render replaced.
// A legitimate future negative mention (explaining why raster export is
// absent, say) earns a reason-commented allowlist entry here, never a
// weakened pattern — see skills-rewrite design risk #2.
const BANNED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string; allow?: RegExp }> = [
  {
    pattern: /Excalidraw/,
    reason: 'the product is JSON Canvas + OKF Markdown over MCP tools, not Excalidraw',
  },
  {
    pattern: /\/api\/debug/,
    reason:
      '/api/debug is a dev-only dump (routes/debug.ts): off unless WHITEBOARD_DEBUG=1, daemon-token-only when on, and never part of the surface a skill may tell a model to use; audits use wb_document_list + wb_canvas_snapshot',
  },
  {
    pattern: /hasActivePort/,
    reason:
      'hasActivePort is no longer a field of the /api/debug response, which answers { workspaces, cache }',
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
  {
    pattern: /\bwb_scene_digest\b/,
    reason:
      'merged into wb_canvas_snapshot (ADR-0010) — pass layout:true for the overlap/containment/cluster/free-region analysis',
  },
  // Claims about what the tools can and cannot do that a tool's own schema or
  // runtime contradicts. A name check cannot see these: every token in them is
  // a real word, and the sentence is simply false.
  {
    pattern: /\bdigest\b/i,
    reason:
      'no tool returns a digest: wb_scene_digest was merged into wb_canvas_snapshot — say its nodeCount, or layout:true',
  },
  {
    pattern: /no rich formatting/i,
    reason:
      'a text node is Markdown and the renderer draws headings, bold, lists, task boxes and highlighted code fences',
  },
  {
    pattern: /section-level (render|export)/i,
    reason: 'wb_scene_render takes `fragment`, which draws one group by its label or one heading',
  },
  {
    pattern: /\bdash(ed|es)?\b|\bdotted\b/i,
    reason:
      'no tool has a dash or stroke-style field: edge.add takes color, label, bends and facets, so a convention taught in skills must be one a model can express — color and label',
    allow: /no dash\/line-style field/,
  },
  // Denials of surface a tool now has. Every one of these read as true once
  // and was left standing when the capability landed, so a model followed the
  // skill over the tool's own description.
  {
    pattern: /no (icon|template)( or (icon|template))? (library|catalog)/i,
    reason:
      'wb_facet_list reports the bundled stencils and icons, and node.add takes a `stencil`; teach them rather than deny them',
  },
  {
    pattern: /no auto-sizing/i,
    reason:
      'a text node with no height is made tall enough for its text, and a height too short for it is refused with the height it needs',
  },
  {
    pattern: /no (frame|membership)( feature| tracking)?/i,
    reason:
      'node.add takes `within`, region.set reconciles a group, tidy takes `within`, and a group added with no position is placed around its members',
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
      const content = readSkill(path)
      // A sentence wraps where the author's line ends, so "has no\nmembership
      // tracking" is one claim over two lines: match over the text with line
      // breaks folded to spaces (same offsets), and report the line a match
      // starts on.
      const folded = content.replace(/\n/g, ' ')
      const lineStarts = [0, ...[...content.matchAll(/\n/g)].map((m) => m.index + 1)]
      for (const { pattern, reason, allow } of BANNED_PATTERNS) {
        const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)
        for (const match of folded.matchAll(global)) {
          const lineIndex = lineStarts.filter((start) => start <= match.index).length - 1
          const line = content.split('\n')[lineIndex] ?? ''
          if (allow?.test(line)) continue
          hits.push(`${displayPath(path)}:${lineIndex + 1} matches ${pattern} (${reason})`)
        }
      }
    }
    expect(hits).toEqual([])
  })

  // The converse of the registered-tool check above: that one proves every
  // name a skill uses exists, this one proves every tool that exists is
  // taught. Five tools were registered and named by no skill, so a model
  // reading only the skills was told the capability did not exist.
  //
  // A tool belongs here only with the reason a skill should not teach it.
  // Checked from both sides: an entry that is not a registered tool, or that
  // a skill now names, fails, so the list cannot outlive its reason.
  const NOT_TAUGHT: Readonly<Record<string, string>> = {}

  function skillsNaming(tool: string): string[] {
    const named = new RegExp(`\\b${tool}\\b`)
    return SKILL_FILES.filter((path) => named.test(readSkill(path))).map(displayPath)
  }

  it('every registered tool is named by a skill or is on the not-taught list with a reason', () => {
    expect(ALL_REGISTERED_TOOLS.length).toBeGreaterThan(10)
    const untaught = ALL_REGISTERED_TOOLS.filter(
      (tool) => !(tool in NOT_TAUGHT) && skillsNaming(tool).length === 0,
    )
    expect(untaught).toEqual([])
  })

  it('every not-taught entry is a registered tool, carries a reason, and is still named by no skill', () => {
    const stale = Object.entries(NOT_TAUGHT).flatMap(([tool, reason]) => {
      if (!(ALL_REGISTERED_TOOLS as readonly string[]).includes(tool)) {
        return [`${tool}: not a registered tool`]
      }
      if (reason.trim() === '') return [`${tool}: no reason`]
      const files = skillsNaming(tool)
      return files.length > 0 ? [`${tool}: now named by ${files.join(', ')}`] : []
    })
    expect(stale).toEqual([])
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
    const claudePlugin = readJson(resolve(REPO_ROOT, '.claude-plugin/plugin.json'))
    const codexPlugin = readJson(resolve(REPO_ROOT, '.codex-plugin/plugin.json'))
    expect(claudePlugin.skills).toBe('./skills')
    expect(codexPlugin.skills).toBe('./skills')
    expect(existsSync(SKILLS_ROOT)).toBe(true)

    // Pin the deliberate ABSENCE: reintroducing 'skills' to the npm files
    // array without a consumer would revive the false shipped-skills claim.
    const mcpPackage = readJson(resolve(REPO_ROOT, 'packages/mcp-server/package.json'))
    expect(mcpPackage.files).not.toContain('skills')

    // And the deliberate absence of a SECOND copy. `packages/mcp-server/skills/`
    // was a byte-identical duplicate of this tree, tracked but read by
    // nothing — the guard below only scans the repo root, so a sweep that
    // fixed one copy left the other stale while every assertion stayed
    // green. Deleted 2026-08-18; this keeps it deleted.
    expect(existsSync(resolve(REPO_ROOT, 'packages/mcp-server/skills'))).toBe(false)

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

  // The Agent Skills frontmatter contract, as a schema over a real YAML
  // parse. The block above checks the same two fields with regexes, which is
  // what a line-oriented match can reach; this reaches the shape — a `name`
  // that disagrees with its directory, an `allowed-tools` written as a YAML
  // list instead of the space-separated string the spec calls for, a
  // `metadata` holding anything but strings.
  //
  // `.strict()` because the spec ENUMERATES its keys: an unlisted one is a
  // typo or a convention this repo has not agreed to, and either is worth a
  // deliberate edit here rather than silence.
  const skillFrontmatterSchema = z
    .object({
      name: z.string().min(1),
      description: z.string().min(1),
      license: z.string().min(1).optional(),
      compatibility: z.string().min(1).optional(),
      'allowed-tools': z.string().min(1).optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    })
    .strict()

  // The closing fence has to be a line of exactly three dashes. `\n---`
  // alone also matches `----` and `---trailing junk`, which are not
  // frontmatter terminators — and a file that ends that way parses as
  // whatever happened to precede them, so the malformed part is simply not
  // read rather than reported.
  const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

  function frontmatterProblems(root: string, minimum: number): string[] {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    // Non-vacuity, the same reason the file's first assertion exists: a
    // schema that validates nothing passes.
    if (dirs.length < minimum) {
      return [
        `${displayPath(root)}: found ${dirs.length} skill directories, expected >= ${minimum}`,
      ]
    }

    const problems: string[] = []
    for (const dir of dirs) {
      const skillMdPath = resolve(root, dir, 'SKILL.md')
      if (!existsSync(skillMdPath)) {
        problems.push(`${displayPath(resolve(root, dir))}: no SKILL.md`)
        continue
      }
      const frontmatter = readFileSync(skillMdPath, 'utf-8').match(FRONTMATTER)?.[1]
      if (frontmatter === undefined) {
        problems.push(`${displayPath(skillMdPath)}: no --- frontmatter --- at the top of the file`)
        continue
      }
      let parsed: unknown
      try {
        parsed = parseYaml(frontmatter)
      } catch (err) {
        problems.push(`${displayPath(skillMdPath)}: frontmatter is not YAML (${String(err)})`)
        continue
      }
      const result = skillFrontmatterSchema.safeParse(parsed)
      if (!result.success) {
        for (const issue of result.error.issues) {
          problems.push(`${displayPath(skillMdPath)}: ${issue.path.join('.')} ${issue.message}`)
        }
        continue
      }
      // A skill is addressed by its directory; a `name` saying otherwise
      // makes the two disagree wherever one of them is quoted.
      if (result.data.name !== dir) {
        problems.push(
          `${displayPath(skillMdPath)}: name '${result.data.name}' is not its directory '${dir}'`,
        )
      }
    }
    return problems
  }

  it('every skill under skills/ has spec-conformant frontmatter', () => {
    expect(frontmatterProblems(SKILLS_ROOT, 3)).toEqual([])
  })

  // The repo's OTHER skill root. These are the dev-workflow skills the
  // agent loads, not the product's — a different audience, the same file
  // format, and until now nothing read them as YAML at all. That gap was
  // not theoretical: `testing-techniques` carried an unquoted description
  // containing `Vitest 5's: traceView`, which YAML reads as a nested
  // mapping, so its whole frontmatter failed to parse.
  it('every skill under .claude/skills/ has spec-conformant frontmatter', () => {
    expect(frontmatterProblems(resolve(REPO_ROOT, '.claude/skills'), 10)).toEqual([])
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
