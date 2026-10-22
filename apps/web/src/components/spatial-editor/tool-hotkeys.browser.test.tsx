// The tool letters and N on the focused canvas, in a real browser.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const empty: SpatialCanvas = { nodes: [], edges: [] }
const pressed = (container: HTMLElement, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-pressed')

it('V, H, C and D switch the armed tool on the focused canvas', async () => {
  const { Host } = makeEditorHost({ initial: empty })
  const { container } = render(<Host />)
  rootOf(container).focus()
  await userEvent.keyboard('v')
  await expect.poll(() => pressed(container, 'select-tool-button')).toBe('true')
  await userEvent.keyboard('h')
  await expect.poll(() => pressed(container, 'hand-tool-button')).toBe('true')
  await userEvent.keyboard('c')
  await expect.poll(() => pressed(container, 'connect-tool-button')).toBe('true')
  await userEvent.keyboard('d')
  await expect.poll(() => pressed(container, 'draw-tool-button')).toBe('true')
})

it('N adds a note at the viewport centre', async () => {
  const { Host, latest } = makeEditorHost({ initial: empty })
  const { container } = render(<Host />)
  rootOf(container).focus()
  await userEvent.keyboard('n')
  await expect.poll(() => latest.canvas.nodes.length).toBe(1)
})
