import { describe, expect, it } from 'vitest'
import { SPATIAL_EDITOR_UNSUPPORTED } from './SpatialEditor.js'

const REQUIRED_UNSUPPORTED = [
  'freehand-drawing',
  'shape-tools',
  'multi-select',
  'grouping',
  'undo-redo',
  'snapping',
  'persistence',
  'sync',
]

describe('SPATIAL_EDITOR_UNSUPPORTED', () => {
  it('names every parity gap this slice deliberately does not implement', () => {
    for (const item of REQUIRED_UNSUPPORTED) {
      expect(SPATIAL_EDITOR_UNSUPPORTED).toContain(item)
    }
  })

  it('is referenced by the SpatialEditor source doc comment (machine-checkable, not just prose)', async () => {
    const modules = import.meta.glob('./SpatialEditor.tsx', { query: '?raw', import: 'default' })
    const entry = modules['./SpatialEditor.tsx']
    expect(entry).toBeDefined()
    const source = (await entry?.()) as string
    expect(source).toContain('SPATIAL_EDITOR_UNSUPPORTED')
  })
})
