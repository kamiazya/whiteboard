// layoutMdastBlocks is the markdown entry point every surface calls, so the
// tokeniser and its palette are its defaults: a surface that has to remember
// to pass them draws a fence in one fill while the canvas colours the same one.
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '../theme/spatial-palette.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutMdastBlocks } from './markdown-body.js'

const root: MdastRoot = {
  type: 'root',
  children: [{ type: 'code', lang: 'ts', meta: null, value: 'const x = 1 // note' }],
}
const base = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }

const fills = (extra: Record<string, unknown> = {}) => {
  const scene = layoutMdastBlocks(root, { ...base, ...extra })
  const code = scene.nodes.find((node) => node.kind === 'codeBlock')
  if (code === undefined || code.kind !== 'codeBlock') throw new Error('expected a codeBlock')
  return (code.runs ?? []).map((run) => run.appearance?.fill)
}

describe('layoutMdastBlocks highlights fences by default', () => {
  it('colours a ts fence in more than one fill with no seam passed', () => {
    expect(new Set(fills()).size).toBeGreaterThan(1)
  })

  it('takes the syntax palette from the canvas appearance mode', () => {
    const dark = fills({ canvasAppearance: createSpatialTheme({ mode: 'dark' }) })
    expect(dark).toContain(SPATIAL_DARK_PALETTE.syntax.keyword)
    expect(fills()).toContain(SPATIAL_LIGHT_PALETTE.syntax.keyword)
  })
})
