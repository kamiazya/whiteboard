import { parseOkf, parseSpatial } from '@kamiazya/whiteboard-codec'
import { describe, expect, it } from 'vitest'
import { markdownDocumentFile, spatialDocumentFile } from './document-file.js'

describe('markdownDocumentFile', () => {
  it('writes the OKF document with the workspace name as the frontmatter title', async () => {
    const blob = markdownDocumentFile({
      body: '# Heading\n\nText\n',
      name: 'Trip plan',
      coreFacets: { type: 'note', tags: ['a'] },
      facets: {},
    })
    const parsed = parseOkf(await blob.text())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.frontmatter.title).toBe('Trip plan')
    expect(parsed.value.frontmatter.type).toBe('note')
    expect(parsed.value.body).toBe('# Heading\n\nText\n')
  })

  it('omits the title for an unnamed document and types a bare body', async () => {
    const blob = markdownDocumentFile({ body: 'x', name: null, coreFacets: undefined, facets: {} })
    const parsed = parseOkf(await blob.text())
    expect(parsed.ok && parsed.value.frontmatter.title).toBeFalsy()
    expect(parsed.ok && parsed.value.frontmatter.type).toBeTruthy()
  })
})

describe('spatialDocumentFile', () => {
  it('writes extended JSON Canvas that parses back to the same nodes', async () => {
    const canvas = {
      nodes: [{ id: 'n1', type: 'text' as const, x: 1, y: 2, width: 100, height: 50, text: 'hi' }],
      edges: [],
    }
    const blob = spatialDocumentFile(canvas)
    const parsed = parseSpatial(await blob.text())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.nodes[0]?.id).toBe('n1')
  })
})
