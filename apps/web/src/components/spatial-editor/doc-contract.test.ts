import { describe, expect, it } from 'vitest'
import { SPATIAL_EDITOR_UNSUPPORTED } from './SpatialEditor.js'

const REQUIRED_UNSUPPORTED = [
  'freehand-drawing',
  'shape-tools',
  'multi-select',
  'grouping',
  'undo-redo',
  'arrow-side-pinning',
  'snapping',
  'persistence',
  'sync',
]

describe('SPATIAL_EDITOR_UNSUPPORTED', () => {
  it('names exactly every parity gap this slice deliberately does not implement (both directions: nothing missing, nothing undocumented)', () => {
    expect([...SPATIAL_EDITOR_UNSUPPORTED].sort()).toEqual([...REQUIRED_UNSUPPORTED].sort())
  })

  it('is referenced by the SpatialEditor source doc comment (machine-checkable, not just prose)', async () => {
    const modules = import.meta.glob('./SpatialEditor.tsx', { query: '?raw', import: 'default' })
    const entry = modules['./SpatialEditor.tsx']
    expect(entry).toBeDefined()
    const source = (await entry?.()) as string
    const docComment = source.match(/^\/\*\*[\s\S]*?\*\//)?.[0]
    expect(docComment).toBeDefined()
    expect(docComment).toContain('SPATIAL_EDITOR_UNSUPPORTED')
  })

  it('documents creation and deletion as SUPPORTED, and neither is listed as an unsupported gap', async () => {
    const modules = import.meta.glob('./SpatialEditor.tsx', { query: '?raw', import: 'default' })
    const entry = modules['./SpatialEditor.tsx']
    const source = (await entry?.()) as string
    const docComment = source.match(/^\/\*\*[\s\S]*?\*\//)?.[0]
    expect(docComment).toBeDefined()
    const supportedSection = docComment?.match(
      /Supported:[\s\S]*?(?=\n \*\n| \* The component)/,
    )?.[0]
    expect(supportedSection).toBeDefined()
    expect(supportedSection?.toLowerCase()).toContain('create')
    expect(supportedSection?.toLowerCase()).toContain('delete')
    expect(SPATIAL_EDITOR_UNSUPPORTED.some((item) => /create|delete/.test(item))).toBe(false)
  })
})
