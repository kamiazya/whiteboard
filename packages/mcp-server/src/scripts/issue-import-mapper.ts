import { parse } from 'yaml'
import type { OkfMarkdownDocument } from '@kamiazya/whiteboard-canvas-codec'
import type { IssueFacetPayload } from '@kamiazya/whiteboard-canvas-model'

export type IssueImportResult =
  | { ok: true; segment: string; document: OkfMarkdownDocument }
  | { ok: false; reason: string }

interface RawFrontmatter {
  id?: string
  status?: string
  severity?: string
  owner?: string
  created?: string
  'blocked-by'?: string[]
  related?: string[]
  [key: string]: unknown
}

function parseFrontmatter(content: string): { frontmatter: RawFrontmatter; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null
  try {
    const frontmatter = parse(match[1]) as RawFrontmatter
    return { frontmatter, body: match[2] }
  } catch {
    return null
  }
}

function deriveSegment(id: string): string {
  return id.replace(/\./g, '-')
}

function buildReferencesSection(
  blockedBy: string[] | undefined,
  related: string[] | undefined,
): string {
  const lines: string[] = []
  if (blockedBy?.length) {
    lines.push('## Blocked by')
    lines.push('')
    for (const ref of blockedBy) lines.push(`- [[${ref}]]`)
    lines.push('')
  }
  if (related?.length) {
    lines.push('## Related')
    lines.push('')
    for (const ref of related) lines.push(`- [[${ref}]]`)
    lines.push('')
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}

export function mapTmpIssueFile(content: string, filename: string): IssueImportResult {
  const parsed = parseFrontmatter(content)
  if (!parsed) {
    return { ok: false, reason: `${filename}: failed to parse YAML frontmatter` }
  }

  const { frontmatter, body } = parsed

  if (!frontmatter.status) {
    return { ok: false, reason: `${filename}: missing required field "status"` }
  }

  const id = frontmatter.id ?? filename.replace(/\.md$/, '')
  const segment = deriveSegment(id)

  const issueFacet: IssueFacetPayload = {
    status: frontmatter.status,
    ...(frontmatter.severity !== undefined && {
      priority: frontmatter.severity.toLowerCase(),
    }),
    ...(frontmatter.owner !== undefined &&
      frontmatter.owner !== 'unassigned' && {
        assignees: [frontmatter.owner],
      }),
  }

  const refsSection = buildReferencesSection(frontmatter['blocked-by'], frontmatter.related)
  const fullBody = body + refsSection

  const document: OkfMarkdownDocument = {
    frontmatter: {
      type: 'issue',
      facets: {
        'issue/1': issueFacet,
      },
    },
    body: fullBody,
  }

  return { ok: true, segment, document }
}
