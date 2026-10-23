/**
 * The touch sheet is a bounded modal surface, not a slab: it names its
 * subject, is capped at half the editor so the pressed object stays in view,
 * scrolls inside, and dims what it covers.
 */
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { currentOccluders } from '../../lib/spatial/viewport-insets.js'
import { ContextMenu } from './ContextMenu.js'

afterEach(cleanup)

const manyRows = Array.from({ length: 24 }, (_, index) => ({
  label: `Action ${index}`,
  onSelect: () => {},
}))

function Host() {
  const [open, setOpen] = useState(true)
  return (
    <div
      data-testid="root"
      style={{ position: 'relative', width: 360, height: 640, overflow: 'hidden' }}
    >
      {open ? (
        <ContextMenu
          x={0}
          y={0}
          variant="sheet"
          label="Actions for Note: Orders"
          title="Note: Orders"
          items={manyRows}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

const rectOf = (selector: string) => {
  const element = document.querySelector(selector)
  if (element === null) throw new Error(`no ${selector}`)
  return element.getBoundingClientRect()
}

it('caps the sheet at half the editor and scrolls inside it', async () => {
  render(<Host />)
  await expect.element(page.getByRole('menu')).toBeInTheDocument()
  expect(rectOf('[data-testid="context-menu"]').height).toBeLessThanOrEqual(320 + 1)
  const menu = document.querySelector<HTMLElement>('[data-testid="context-menu"]')
  expect(menu !== null && menu.scrollHeight > menu.clientHeight).toBe(true)
})

it('shows its subject as a visible title and a drag handle', async () => {
  render(<Host />)
  await expect.element(page.getByText('Note: Orders')).toBeVisible()
  expect(document.querySelector('[data-sheet-handle]')).not.toBeNull()
  await expect.element(page.getByRole('menu', { name: 'Actions for Note: Orders' })).toBeVisible()
})

it('dims the editor behind it and closes on a press of the scrim', async () => {
  render(<Host />)
  const scrim = page.getByTestId('context-menu-scrim')
  await expect.element(scrim).toBeVisible()
  await userEvent.click(scrim, { position: { x: 20, y: 20 } })
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
})

it('registers as an occluder so the pressed node is panned clear of it', async () => {
  render(<Host />)
  await expect.element(page.getByRole('menu')).toBeInTheDocument()
  expect(currentOccluders().some((el) => el.dataset.testid === 'context-menu')).toBe(true)
})
