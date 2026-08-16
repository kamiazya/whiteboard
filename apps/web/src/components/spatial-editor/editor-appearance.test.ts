import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  createEditorAppearance,
  EDITOR_DARK_PALETTE,
  EDITOR_LIGHT_PALETTE,
} from './editor-appearance.js'

const textNode: SpatialNode = {
  id: 'a',
  type: 'text',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: 'hi',
}
const edge = { id: 'e', fromNode: 'a', toNode: 'b' }

describe('createEditorAppearance', () => {
  it('resolves the light theme with the shared per-type fill and the accessible stroke', () => {
    // The stroke value stays byte-identical to the pre-theme-layer editor
    // (`#737373`); node FILL now differentiates per type (canvas-render's
    // shared palette), which is the theme layer's intended convergence with
    // the viewer/export surfaces — see package-canvas-render.md decision #8.
    const appearance = createEditorAppearance('light')
    expect(appearance.resolveNode(textNode).appearance).toEqual({
      fill: '#ffffff',
      stroke: '#737373',
    })
    expect(appearance.resolveEdge(edge as never)).toEqual({ stroke: '#737373' })
  })

  it('resolves a dark palette with real contrast against the dark canvas surface', () => {
    const appearance = createEditorAppearance('dark')
    expect(appearance.resolveNode(textNode).appearance).toEqual({
      fill: 'none',
      stroke: EDITOR_DARK_PALETTE.chromeStroke,
    })
    expect(appearance.resolveEdge(edge as never)).toEqual({
      stroke: EDITOR_DARK_PALETTE.chromeStroke,
    })
    expect(EDITOR_DARK_PALETTE.chromeStroke).not.toBe('#737373')
    expect(EDITOR_DARK_PALETTE.chromeStroke).not.toBe(EDITOR_LIGHT_PALETTE.chromeStroke)
  })

  it('themes the label fill, not just chrome stroke, in both modes', () => {
    const light = createEditorAppearance('light')
    const dark = createEditorAppearance('dark')
    expect(light.resolveLabel().fill).toBe(EDITOR_LIGHT_PALETTE.textFill)
    expect(dark.resolveLabel().fill).toBe(EDITOR_DARK_PALETTE.textFill)
    expect(dark.resolveLabel().fill).not.toBe(light.resolveLabel().fill)
  })

  it('returns a referentially stable resolver per theme', () => {
    expect(createEditorAppearance('dark')).toBe(createEditorAppearance('dark'))
    expect(createEditorAppearance('light')).toBe(createEditorAppearance('light'))
  })
})
