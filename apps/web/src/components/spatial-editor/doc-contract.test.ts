// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SPATIAL_EDITOR_UNSUPPORTED } from './SpatialEditor.js'

// Grouping (J4), undo/redo (the LoroDoc UndoManager behind the dock's
// history cluster), alignment/distribution, and snapping all shipped and
// left this list. Freehand and shape tools left it for the opposite reason:
// they are out of scope, not deferred — JSON Canvas 1.0 has no node for
// them. A list of "not yet" must not carry "never".
const REQUIRED_UNSUPPORTED = ['persistence', 'sync']

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

  it('never lists a capability the editor actually ships', async () => {
    // The list is a promise to the reader; a stale entry is worse than no
    // list. These all ship today (J4 groups, the history cluster's
    // undo/redo, the slice-4/5 clipboard family, and drag snapping).
    for (const shipped of [
      'grouping',
      'undo-redo',
      'clipboard',
      'duplicate',
      'snapping',
      // Not shipped — out of scope. Either way it does not belong on a
      // list the reader reads as a promise.
      'freehand-drawing',
      'shape-tools',
    ]) {
      expect(SPATIAL_EDITOR_UNSUPPORTED).not.toContain(shipped)
    }
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
