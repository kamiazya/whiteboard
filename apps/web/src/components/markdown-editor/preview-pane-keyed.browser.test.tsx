import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PreviewPane } from './PreviewPane'

afterEach(cleanup)

const measure = (text: string) => ({
  advanceWidth: text.length * 6,
  ascent: 10,
  descent: 3,
  lineGap: 3,
})

it('editing one block patches only that block: the untouched group keeps its DOM element', async () => {
  const { container, rerender } = render(
    <PreviewPane value={'first paragraph\n\nsecond paragraph'} measure={measure} maxWidth={400} />,
  )
  const groups = () => [...container.querySelectorAll('[data-wb-key]')]
  expect(groups().length).toBeGreaterThanOrEqual(2)
  const [keptFirst] = groups()

  rerender(
    <PreviewPane value={'first paragraph\n\nsecond EDITED'} measure={measure} maxWidth={400} />,
  )
  const after = groups()
  expect(after[0]).toBe(keptFirst)
  expect(container.innerHTML).toContain('EDITED')
})
