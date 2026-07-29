import { describe, expect, test } from 'vitest'
import { parseOkf, serializeOkf } from '@kamiazya/whiteboard-canvas-codec'
import { mapTmpIssueFile } from './issue-import-mapper.js'

const MINIMAL_ISSUE = `---
id: TEST-001
status: open
severity: low
owner: unassigned
created: 2026-07-05
---

# Test issue

Some body text.
`

describe('mapTmpIssueFile', () => {
  test('maps status to issue/1 status', () => {
    const result = mapTmpIssueFile(MINIMAL_ISSUE, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.frontmatter.facets?.['issue/1']).toMatchObject({
      status: 'open',
    })
  })

  test('maps severity to issue/1 priority with case normalization', () => {
    const content = MINIMAL_ISSUE.replace('severity: low', 'severity: HIGH')
    const result = mapTmpIssueFile(content, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.frontmatter.facets?.['issue/1']).toMatchObject({
      priority: 'high',
    })
  })

  test('maps owner to issue/1 assignees (skips unassigned)', () => {
    const result = mapTmpIssueFile(MINIMAL_ISSUE, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const facet = result.document.frontmatter.facets?.['issue/1'] as Record<string, unknown>
    expect(facet.assignees).toBeUndefined()
  })

  test('maps owner to issue/1 assignees (wraps in array)', () => {
    const content = MINIMAL_ISSUE.replace('owner: unassigned', 'owner: alice')
    const result = mapTmpIssueFile(content, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.frontmatter.facets?.['issue/1']).toMatchObject({
      assignees: ['alice'],
    })
  })

  test('derives segment from id (dots replaced with hyphens)', () => {
    const content = MINIMAL_ISSUE.replace('id: TEST-001', 'id: foo.bar.baz')
    const result = mapTmpIssueFile(content, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.segment).toBe('foo-bar-baz')
  })

  test('appends blocked-by and related as wikilink references', () => {
    const content = `---
id: TEST-002
status: open
severity: medium
owner: unassigned
created: 2026-07-05
blocked-by:
  - blocker-a
  - blocker-b
related:
  - related-x
---

# Issue with refs
`
    const result = mapTmpIssueFile(content, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.body).toContain('[[blocker-a]]')
    expect(result.document.body).toContain('[[blocker-b]]')
    expect(result.document.body).toContain('[[related-x]]')
  })

  test('returns ok:false for missing frontmatter', () => {
    const result = mapTmpIssueFile('# No frontmatter\n\nJust text.', 'test.md')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBeTruthy()
  })

  test('returns ok:false for missing status field', () => {
    const content = `---
id: TEST-003
severity: low
owner: unassigned
created: 2026-07-05
---

# Missing status
`
    const result = mapTmpIssueFile(content, 'test.md')
    expect(result.ok).toBe(false)
  })

  test('sets frontmatter type to issue', () => {
    const result = mapTmpIssueFile(MINIMAL_ISSUE, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.frontmatter.type).toBe('issue')
  })

  test('round-trip: output document is valid OKF Markdown', () => {
    const result = mapTmpIssueFile(MINIMAL_ISSUE, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const serialized = serializeOkf(result.document)
    const parsed = parseOkf(serialized)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.frontmatter.facets?.['issue/1']).toMatchObject({
      status: 'open',
    })
  })

  test('handles empty body', () => {
    const content = `---
id: TEST-004
status: done
severity: low
owner: unassigned
created: 2026-07-05
---
`
    const result = mapTmpIssueFile(content, 'test.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.body).toBe('')
  })
})
