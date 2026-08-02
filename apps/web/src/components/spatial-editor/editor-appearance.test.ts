import type { SpatialNode } from '@kamiazya/whiteboard-canvas-model'
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
  it('resolves the pre-existing light chrome so light mode stays byte-identical', () => {
    const appearance = createEditorAppearance('light')
    expect(appearance.resolveNode(textNode).appearance).toEqual({ fill: 'none', stroke: '#333333' })
    expect(appearance.resolveEdge(edge as never)).toEqual({ stroke: '#333333' })
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
    expect(EDITOR_DARK_PALETTE.chromeStroke).not.toBe('#333333')
    expect(EDITOR_DARK_PALETTE.chromeStroke).not.toBe(EDITOR_LIGHT_PALETTE.chromeStroke)
  })

  it('themes the label fill, not just chrome stroke, in both modes', () => {
    const light = createEditorAppearance('light')
    const dark = createEditorAppearance('dark')
    expect(light.resolveLabel()).toEqual({ fill: EDITOR_LIGHT_PALETTE.textFill })
    expect(dark.resolveLabel()).toEqual({ fill: EDITOR_DARK_PALETTE.textFill })
    expect(dark.resolveLabel().fill).not.toBe(light.resolveLabel().fill)
  })

  it('keeps geometry constants theme-independent', () => {
    const light = createEditorAppearance('light')
    const dark = createEditorAppearance('dark')
    expect(dark.paddingPx).toBe(light.paddingPx)
    expect(dark.labelFontSizePx).toBe(light.labelFontSizePx)
    expect(dark.minContentWidthPx).toBe(light.minContentWidthPx)
  })

  it('returns a referentially stable resolver per theme', () => {
    expect(createEditorAppearance('dark')).toBe(createEditorAppearance('dark'))
    expect(createEditorAppearance('light')).toBe(createEditorAppearance('light'))
  })
})
