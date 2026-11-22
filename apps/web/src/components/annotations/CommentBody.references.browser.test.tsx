/**
 * A comment's `[[alias]]` draws the title of the document it names, as the
 * same text does in a node's body: the rail, the panel and the canvas card all
 * draw prose through `CommentBody`, which takes its bundle from the page.
 */
import { referenceSeamsFromWire } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CommentBody } from './CommentBody.js'
import { CommentReferencesProvider } from './comment-references.js'

afterEach(cleanup)

const seams = referenceSeamsFromWire({
  entries: [['notes', { documentId: 'D-NOTES', name: 'Design notes' }]],
  aliases: [],
  titles: [['D-NOTES', 'Design notes']],
  extras: [],
})

function drawn(container: HTMLElement): string {
  return [...container.querySelectorAll('text')].map((node) => node.textContent ?? '').join(' ')
}

it('draws the resolved title of a reference rather than its brackets', () => {
  const { container } = render(
    <CommentReferencesProvider value={seams}>
      <CommentBody body="see [[notes]] first" compact />
    </CommentReferencesProvider>,
  )
  expect(drawn(container)).toContain('Design notes')
  expect(container.textContent).not.toContain('[[')
})

it('draws a reference as written where the page supplies no bundle', () => {
  const { container } = render(<CommentBody body="see [[notes]] first" compact />)
  expect(container.textContent).toContain('[[notes]]')
  expect(container.textContent).not.toContain('Design notes')
})
