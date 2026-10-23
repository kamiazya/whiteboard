// A selected node grows controls around it. Each says which node it acts on,
// and the keyboard meets one stop per job rather than a stop per handle.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 200, y: 200, width: 160, height: 80, text: 'Draft' }),
    textNode({ id: 'b', x: 500, y: 200, width: 160, height: 80, text: 'Other' }),
  ],
  edges: [],
}

function mountSelected() {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  rootOf(container).focus()
  return userEvent.keyboard('{Tab}').then(() => container)
}

const tabStops = (container: HTMLElement): string[] =>
  [
    ...container.querySelectorAll<SVGElement>('[data-testid="selection-overlay"] [tabindex="0"]'),
  ].map((el) => el.getAttribute('aria-label') ?? '')

it('the controls around a node say which node they act on', async () => {
  await mountSelected()
  await expect
    .element(page.getByRole('button', { name: 'Resize Draft, south-east' }))
    .toBeInTheDocument()
  await expect
    .element(page.getByRole('button', { name: 'More actions for Draft' }))
    .toBeInTheDocument()
  await expect
    .element(
      page.getByRole('button', { name: 'Connect Draft to another node (from the right side)' }),
    )
    .toBeInTheDocument()
})

it('a selected node adds one Tab stop each for resizing, connecting and its actions', async () => {
  const container = await mountSelected()
  expect(tabStops(container)).toEqual([
    'Resize Draft, south-east',
    'Connect Draft to another node (from the right side)',
    'More actions for Draft',
  ])
})
