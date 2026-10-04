// visual.text/v0 reaches the inspector with NO apps/web change at all: it
// is a facet definition carrying an editor spec, rendered by the tier-2 path.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 80, y: 80, width: 200, height: 100, text: 'A' })],
  edges: [],
}

it('the Text row stores the facet and moves the drawn text', () => {
  const { Host, latest } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const textY = () =>
    Number(
      (
        container.querySelector('[data-testid="spatial-editor"] svg text') as SVGTextElement | null
      )?.getAttribute('y') ?? '0',
    )
  const before = textY()

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 180, clientY: r.top + 130 })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  fireEvent.click(
    [...menu.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').startsWith('Facets'),
    ) as HTMLElement,
  )
  const panel = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  fireEvent.click(panel.querySelector('[aria-label="Middle"]') as HTMLElement)

  expect(latest.canvas.nodes[0]?.facets?.['visual.text/v0']).toEqual({
    align: 'center',
  })
  // Not merely stored: a rect's text moved down from the top.
  expect(textY()).toBeGreaterThan(before)
})
