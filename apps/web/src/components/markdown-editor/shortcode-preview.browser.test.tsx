/**
 * The flow a person actually takes: type `:rocket:` in a note, see 🚀 in the
 * preview.
 *
 * In a real browser rather than jsdom because the claim is about what is
 * DRAWN — the preview is an SVG produced by canvas-render, and the node
 * projects have already pinned the projection itself. What only this layer
 * can say is that the pane a person looks at is wired to it.
 *
 * Verified by hand at the same time (`tmp/screenshots` at the time of
 * writing): 🚀 🔥 🤔 😀 all came out in COLOUR here, unlike the facet
 * picker's chips, which inherited a stack resolving to DejaVu Sans. Nothing
 * here can assert that — no API reports which face won — so it is recorded
 * rather than pinned.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { PreviewPane } from './PreviewPane.js'

afterEach(cleanup)

function drawn(value: string): string {
  const { container } = render(<PreviewPane value={value} maxWidth={520} measure={fakeMeasure} />)
  expect(container.querySelector('svg')).not.toBeNull()
  return container.textContent ?? ''
}

describe('a shortcode typed in a note is drawn as its emoji', () => {
  it('draws the emoji in a heading and in a paragraph', () => {
    expect(drawn('# Ship it :rocket:\n\n:fire: hot and :thinking_face: maybe')).toBe(
      'Ship it 🚀🔥 hot and 🤔 maybe',
    )
  })

  /** The safety case, on the surface a person reads it on. */
  it('leaves a colon pair that names no emoji, and one inside code, alone', () => {
    expect(drawn('see :something: at 10:30: and `:rocket:` too')).toContain(':something:')
    expect(drawn('see :something: at 10:30: and `:rocket:` too')).toContain(':rocket:')
  })
})
