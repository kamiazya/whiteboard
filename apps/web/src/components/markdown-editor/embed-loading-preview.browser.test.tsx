/**
 * A note's `![[target]]` while its target is still loading: the preview
 * draws a framed, named block with a loading line rather than plain link
 * text, then the content once the keeper answers. In a real browser because
 * the claim is about what is DRAWN, through the hook, the layout and the
 * SVG backend together.
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { type ReferenceLoader, useReferenceSeams } from '../../hooks/use-reference-seams.js'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { PreviewPane } from './PreviewPane.js'

afterEach(cleanup)

const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

function Note({ value, load }: { value: string; load: ReferenceLoader }) {
  const references = useReferenceSeams({ body: value, load })
  return (
    <PreviewPane
      theme="light"
      value={value}
      maxWidth={520}
      measure={fakeMeasure}
      references={references}
    />
  )
}

const texts = (container: HTMLElement): string =>
  [...container.querySelectorAll('text')].map((node) => node.textContent).join(' ')

describe('an embed in a note whose target is slow to load', () => {
  it('shows Loading while the load is held, then the content once it answers', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load: ReferenceLoader = async () => {
      await gate
      return { documentId: B, name: 'Roadmap', body: 'quarterly goals' }
    }
    const { container } = render(<Note value={`![[${B}]]`} load={load} />)
    await waitFor(() => expect(texts(container)).toContain('Loading…'))
    release?.()
    await waitFor(() => expect(texts(container)).toContain('quarterly goals'))
    expect(texts(container)).not.toContain('Loading…')
  })

  it('shows no Loading line for a target that answers nothing', async () => {
    const { container } = render(<Note value={`![[${B}]]`} load={async () => undefined} />)
    await waitFor(() => expect(texts(container)).not.toContain('Loading…'))
  })
})
