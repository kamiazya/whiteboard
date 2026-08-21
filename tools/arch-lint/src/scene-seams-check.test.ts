import { describe, expect, it } from 'vitest'
import { scanSourceForSceneSeamOmissions } from './scene-seams-check.js'

const scan = (source: string) => scanSourceForSceneSeamOmissions('a.ts', source)

describe('a production scene composition names every required seam', () => {
  it('reports a composition that omits one', () => {
    expect(scan('layoutSpatialCanvas(canvas, { measure, appearance })')).toEqual([
      { seam: 'highlightCode', line: 1 },
    ])
  })

  it('accepts one that names it, including an explicit opt-out', () => {
    expect(scan('layoutSpatialCanvas(canvas, { measure, appearance, highlightCode })')).toEqual([])
    expect(
      scan('layoutSpatialCanvas(canvas, { measure, appearance, highlightCode: undefined })'),
    ).toEqual([])
  })

  it('covers the anchors variant, which is a second composition site', () => {
    expect(scan('layoutSpatialCanvasWithAnchors(canvas, { measure })')).toHaveLength(1)
  })

  it('reports the line, so the message points at the call', () => {
    const [violation] = scan('const a = 1\n\nlayoutSpatialCanvas(canvas, { measure })')
    expect(violation?.line).toBe(3)
  })

  it('ignores a call whose options are not a literal — nothing to read there', () => {
    expect(scan('layoutSpatialCanvas(canvas, options)')).toEqual([])
  })

  it('ignores an unrelated call of the same shape', () => {
    expect(scan('layoutSomethingElse(canvas, { measure })')).toEqual([])
  })
})
