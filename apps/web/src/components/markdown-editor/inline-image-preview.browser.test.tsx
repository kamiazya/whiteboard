/**
 * The flow a person actually takes: an attachment written inline in a note
 * draws its picture in the preview, not the written `asset:` path.
 *
 * In a real browser rather than jsdom because the claim is about what is
 * DRAWN — the preview is an SVG produced by canvas-render — and because the
 * chain under test is the whole one: the hook collects the target, loads its
 * object URL, hands it to the layout through `resolveReference`, and the
 * backend emits it as the `<image>`'s href. Each half is pinned at its own
 * layer; only here are they wired together.
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useReferenceSeams } from '../../hooks/use-reference-seams.js'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { PreviewPane } from './PreviewPane.js'

afterEach(cleanup)

function Note({
  value,
  loadImage,
}: {
  value: string
  loadImage?: (ref: string) => Promise<string>
}) {
  const references = useReferenceSeams({
    body: value,
    load: async () => undefined,
    ...(loadImage === undefined ? {} : { loadImage }),
  })
  return <PreviewPane value={value} maxWidth={520} measure={fakeMeasure} references={references} />
}

const hrefs = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll('image')].map((node) => node.getAttribute('href'))

describe('an attachment written inline in a note', () => {
  it('draws the stored picture rather than the path', async () => {
    const { container } = render(
      <Note value="see ![shot](asset:pic) here" loadImage={async (ref) => `blob:${ref}`} />,
    )
    await waitFor(() => expect(hrefs(container)).toEqual(['blob:asset:pic']))
  })

  /**
   * The counter-case, on the surface a person reads it on: an absolute URL
   * needs no resolution and must survive a host that resolves nothing.
   */
  it('keeps an absolute URL, resolved or not', async () => {
    const { container } = render(<Note value="![](https://example.com/a.png)" />)
    await waitFor(() => expect(hrefs(container)).toEqual(['https://example.com/a.png']))
  })
})
