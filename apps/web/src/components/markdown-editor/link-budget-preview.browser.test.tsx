/**
 * A note naming more documents than the reference walk's loading budget
 * (REFERENCE_BUDGET, 256). The budget bounds what is LOADED; resolving a link
 * through the page's table loads nothing, so link 300 must draw as a link to
 * its document, titled, exactly as link 1 does. In a real browser because the
 * claim is about what is DRAWN, through the hook, the wire, the Rust core and
 * the SVG backend together.
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { type ReferenceLoader, useReferenceSeams } from '../../hooks/use-reference-seams.js'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { PreviewPane } from './PreviewPane.js'

afterEach(cleanup)

const COUNT = 300
const idOf = (i: number) => `01BX5ZZKBKACTAV9WEVG${String(i).padStart(6, '0')}`
const indexOf = (target: string) => Number(target.slice('note-'.length))
const resolveAlias = (alias: string) => (alias.startsWith('note-') ? idOf(indexOf(alias)) : null)
const resolveTitle = (id: string) => `Note ${Number(id.slice(20))}`
const body = Array.from({ length: COUNT }, (_, i) => `[[note-${i}]]`).join(' ')

function Note({ load }: { load: ReferenceLoader }) {
  const references = useReferenceSeams({ body, resolveAlias, resolveTitle, load })
  return (
    <PreviewPane
      theme="light"
      value={body}
      maxWidth={520}
      measure={fakeMeasure}
      references={references}
    />
  )
}

/** A link's words, which the layout may draw as one run per word. */
const linkText = (container: HTMLElement, i: number): string =>
  [...container.querySelectorAll(`a[href="${idOf(i)}"]`)].map((a) => a.textContent).join(' ')

describe('a note naming more links than the loading budget', () => {
  it('draws a link past the budget as a titled link, as it draws the first', async () => {
    const loaded: string[] = []
    // Every target exists: the keeper answers each one it is asked for.
    const load: ReferenceLoader = async (target, documentId) => {
      loaded.push(target)
      return { documentId: documentId ?? idOf(indexOf(target)), body: `prose of ${target}` }
    }
    const { container } = render(<Note load={load} />)
    await waitFor(() => expect(linkText(container, 0)).toBe('Note 0'))
    await waitFor(() => expect(loaded).toHaveLength(256))
    await waitFor(() => expect(linkText(container, COUNT - 1)).toBe(`Note ${COUNT - 1}`))
    expect(linkText(container, 256)).toBe('Note 256')
    const texts = [...container.querySelectorAll('text')].map((node) => node.textContent)
    expect(texts.filter((text) => text?.includes('[[note-'))).toEqual([])
  })
})
