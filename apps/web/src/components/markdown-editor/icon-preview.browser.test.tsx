/**
 * The flow a person actually takes: type `:icon-star:` in a note, see the
 * drawn star in the preview.
 *
 * The sibling of `shortcode-preview.browser.test.tsx`, and in a real browser
 * for the same reason: the node projects pin the projection, and what only
 * this layer can say is that the pane a person looks at is wired to it.
 *
 * It asserts the `<use>` rather than any pixel, because that reference IS
 * the difference between an icon and prose — a run that failed to resolve
 * paints its own text, so finding `<text>` where a `<use>` was expected is
 * exactly the silent degradation this guards.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { PreviewPane } from './PreviewPane.js'

afterEach(cleanup)

function svgOf(value: string): SVGSVGElement {
  const { container } = render(<PreviewPane value={value} maxWidth={520} measure={fakeMeasure} />)
  const svg = container.querySelector('svg')
  expect(svg).not.toBeNull()
  return svg as SVGSVGElement
}

describe('an icon shortcode typed in a note', () => {
  it('is drawn as the icon, not as its source', () => {
    const svg = svgOf('a :icon-star: here')
    expect(svg.querySelector('use[href="#wb-icon-star"]')).not.toBeNull()
    expect(svg.querySelector('symbol#wb-icon-star')).not.toBeNull()
    expect(svg.textContent ?? '').not.toContain('icon-star')
  })

  /**
   * Asserted on the `<use>`'s closest painted ancestor, not on the element:
   * the backend puts `stroke` on the reference and `hoist.ts` then lifts it
   * onto a wrapping `<g>`, so reading the attribute off the `<use>` answers
   * null on output that is completely correct.
   */
  it('takes the prose colour, since no host paints a stroke', () => {
    const use = svgOf(':icon-lock:').querySelector('use') as SVGUseElement
    expect(use.closest('[stroke]')?.getAttribute('stroke')).toBe('currentColor')
  })

  /** The safety case, on the surface a person reads it on. */
  it('leaves an unknown name, and one inside code, as written', () => {
    const svg = svgOf('see :icon-nope: and `:icon-star:` too')
    expect(svg.querySelector('use')).toBeNull()
    expect(svg.textContent ?? '').toContain(':icon-nope:')
    expect(svg.textContent ?? '').toContain(':icon-star:')
  })
})
