// An SVG's root `width`/`height` are free text from a document's own
// `data:` image, so reading them has to cost time linear in their length.

import { describe, expect, it } from 'vitest'

import { boundedDataImages } from './data-image-budget.js'
import { declaredPixels } from './image-dimensions.js'

const SPACES = ' '.repeat(50_000)
// A width that backtracks quadratically through a `\s*…\s*$` pattern before
// failing on the trailing `x`.
const PADDED_SVG = `<svg width="1${SPACES}x" height="1"/>`
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

// Linear work over 50k characters is well under a millisecond; the quadratic
// read it guards against took over a second. The ceiling sits between with
// room for a loaded machine.
const CEILING_MS = 100

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now()
  const value = run()
  return { value, ms: performance.now() - start }
}

describe('an SVG root length padded with whitespace', () => {
  it('is unsizeable, and is read in linear time', () => {
    const { value, ms } = timed(() => declaredPixels('image/svg+xml', bytes(PADDED_SVG)))
    expect(value).toBeUndefined()
    expect(ms).toBeLessThan(CEILING_MS)
  })

  it('is dropped by the export budget in linear time', () => {
    const href = `data:image/svg+xml;base64,${Buffer.from(PADDED_SVG).toString('base64')}`
    const { value, ms } = timed(() => boundedDataImages(`<svg><image x="0" href="${href}"/></svg>`))
    expect(value).toBe('<svg><image x="0"/></svg>')
    expect(ms).toBeLessThan(CEILING_MS)
  })

  it('still sizes a length with surrounding whitespace and a px unit', () => {
    expect(declaredPixels('image/svg+xml', bytes('<svg width=" 20px " height="\t30.5 "/>'))).toBe(
      20 * 31,
    )
  })

  it('treats a length longer than any real one as unsizeable', () => {
    const long = `<svg width="${'0'.repeat(80)}1" height="1"/>`
    expect(declaredPixels('image/svg+xml', bytes(long))).toBeUndefined()
  })
})
