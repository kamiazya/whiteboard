// The shortcut sheet in a real browser: the dock's Help button opens it,
// Escape closes it with focus handed back, and `?` on the focused canvas
// opens it too.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const empty: SpatialCanvas = { nodes: [], edges: [] }

it('the dock button opens the sheet, Escape closes it, focus returns to the button', async () => {
  const { Host } = makeEditorHost({ initial: empty })
  const { container } = render(<Host />)
  const button = container.querySelector('[data-testid="shortcuts-button"]') as HTMLElement
  await userEvent.click(button)
  await expect.element(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.poll(() => document.activeElement).toBe(button)
})

it('pressing ? on the focused canvas opens the sheet', async () => {
  const { Host } = makeEditorHost({ initial: empty })
  const { container } = render(<Host />)
  rootOf(container).focus()
  await userEvent.keyboard('?')
  await expect.element(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
})
