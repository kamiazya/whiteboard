/**
 * A menu opened from the keyboard is a visit: closing it by the keyboard
 * hands focus back to what held it, as every other popover in the app does.
 * Real browser, because `document.activeElement` after a commit is the claim.
 */
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ContextMenu } from './ContextMenu.js'

afterEach(cleanup)

function Host() {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(true)}>
        Opener
      </button>
      {open ? (
        <ContextMenu
          x={10}
          y={30}
          label="Test actions"
          items={[{ label: 'Rename', onSelect: () => {} }]}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

it('returns focus to the opener when Escape closes the menu', async () => {
  render(<Host />)
  await userEvent.click(page.getByRole('button', { name: 'Opener' }))
  await expect.element(page.getByRole('menu', { name: 'Test actions' })).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  await expect.element(page.getByRole('button', { name: 'Opener' })).toHaveFocus()
})

it('returns focus to the opener after an item is chosen by the keyboard', async () => {
  render(<Host />)
  await userEvent.click(page.getByRole('button', { name: 'Opener' }))
  await userEvent.tab()
  await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  await expect.element(page.getByRole('button', { name: 'Opener' })).toHaveFocus()
})
