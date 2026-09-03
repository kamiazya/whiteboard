import { describe, expect, it } from 'vitest'
import { RENDERER_BUILD_ID, renderKeyOf, renderKeyPath, renderKeySchema } from './render-key.js'

const spatial = { documentId: 'doc-1', kind: 'spatial' as const, updatedAt: '2026-09-03T00:00:00Z' }
const markdown = {
  documentId: 'doc-2',
  kind: 'markdown' as const,
  updatedAt: '2026-09-03T00:00:00Z',
}

describe('renderKeyOf', () => {
  it('carries the theme for a spatial document, whose palette is baked into the SVG', () => {
    expect(renderKeyOf(spatial, 'light').theme).toBe('light')
    expect(renderKeyOf(spatial, 'dark').theme).toBe('dark')
  })

  // The whole reason a markdown row survives a theme toggle: its ink comes
  // from CSS, so the same bytes serve both themes and the axis is absent
  // rather than set to something.
  it('omits the theme for a markdown document, whose ink comes from CSS', () => {
    expect(renderKeyOf(markdown, 'light').theme).toBeNull()
    expect(renderKeyPath(renderKeyOf(markdown, 'light'))).toBe(
      renderKeyPath(renderKeyOf(markdown, 'dark')),
    )
  })

  it('separates two themes of the SAME spatial document', () => {
    expect(renderKeyPath(renderKeyOf(spatial, 'light'))).not.toBe(
      renderKeyPath(renderKeyOf(spatial, 'dark')),
    )
  })

  it('changes when the document does', () => {
    const later = { ...spatial, updatedAt: '2026-09-03T01:00:00Z' }
    expect(renderKeyPath(renderKeyOf(later, 'light'))).not.toBe(
      renderKeyPath(renderKeyOf(spatial, 'light')),
    )
  })

  // A keeper that does not stamp updatedAt still gets a key; what it loses is
  // the ability to notice a change, which is a persistence concern and not a
  // reason to render the same document twice inside one sitting.
  it('accepts a document with no version stamp', () => {
    const key = renderKeyOf({ documentId: 'doc-3', kind: 'spatial' }, 'light')
    expect(key.version).toBeNull()
    expect(renderKeySchema.safeParse(key).success).toBe(true)
  })

  it('leads the path with the build id, so retiring a build is one directory', () => {
    expect(renderKeyPath(renderKeyOf(spatial, 'light')).startsWith(`${RENDERER_BUILD_ID}/`)).toBe(
      true,
    )
  })

  it('is a valid key by its own schema', () => {
    expect(renderKeySchema.safeParse(renderKeyOf(spatial, 'dark')).success).toBe(true)
  })
})
