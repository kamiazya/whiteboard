import { describe, expect, it } from 'vitest'
import { EXPORT_MAX_PIXELS, EXPORT_MAX_SIDE_PX, refuseOversizedTarget } from './export-budget.js'

const root = (width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="1" height="1"/></svg>`

describe('the PNG target budget', () => {
  it.each([
    ['a side at the limit', root(EXPORT_MAX_SIDE_PX, 16), 1],
    ['the whole budget, square', root(8192, 8192), 1],
    ['a scaled target at the limit', root(2048, 512), 8],
  ])('admits %s', (_name, svg, zoom) => {
    expect(() => refuseOversizedTarget(svg, zoom)).not.toThrow()
  })

  it.each([
    ['one pixel past the side', root(EXPORT_MAX_SIDE_PX + 1, 16), 1],
    ['one row past the area', root(8192, 8193), 1],
    ['a scale that crosses the side', root(2049, 16), 8],
    ['a node a million px a side at 8x', root(1e6, 1e6), 8],
    ['a root with no size', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 1],
  ])('refuses %s', (_name, svg, zoom) => {
    expect(() => refuseOversizedTarget(svg, zoom)).toThrow(
      expect.objectContaining({ name: 'ExportTooLargeError' }),
    )
  })

  it('reads the root, not a nested element', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="${EXPORT_MAX_PIXELS}" height="1"/></svg>`
    expect(() => refuseOversizedTarget(svg, 1)).not.toThrow()
  })
})
