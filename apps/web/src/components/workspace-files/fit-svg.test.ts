// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fitSvgToBox } from './fit-svg.js'

describe('fitSvgToBox', () => {
  it('drops the document’s own extent so the box decides the size', () => {
    const out = fitSvgToBox(
      '<svg xmlns="x" width="2000" height="1400" viewBox="0 0 2000 1400"><g/></svg>',
    )
    expect(out).not.toMatch(/width=/)
    expect(out).not.toMatch(/height=/)
    expect(out).toContain('viewBox="0 0 2000 1400"')
    expect(out).toContain('preserveAspectRatio="xMidYMid meet"')
  })

  // Without a viewBox there is nothing to scale TO, and stripping the extent
  // would leave an element with no intrinsic size at all — it would collapse
  // rather than fit.
  it('leaves an SVG that has no viewBox exactly as it was', () => {
    const input = '<svg xmlns="x" width="10" height="10"><g/></svg>'
    expect(fitSvgToBox(input)).toBe(input)
  })

  // A scene embeds nested <svg> fragments for math and diagrams, and those
  // carry their own size on purpose.
  // The nested fragment carries a viewBox of its own, or the viewBox guard
  // above would spare it and this would pass without the anchor.
  it('touches only the root tag, not a nested fragment', () => {
    const out = fitSvgToBox(
      '<svg xmlns="x" width="100" height="50" viewBox="0 0 100 50"><svg width="8" height="8" viewBox="0 0 8 8"/></svg>',
    )
    expect(out).toContain('<svg width="8" height="8" viewBox="0 0 8 8"/>')
  })

  it('replaces an aspect rule the renderer had already written', () => {
    const out = fitSvgToBox('<svg viewBox="0 0 4 4" preserveAspectRatio="none" width="4"></svg>')
    expect(out).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(out).not.toContain('preserveAspectRatio="none"')
  })
})
