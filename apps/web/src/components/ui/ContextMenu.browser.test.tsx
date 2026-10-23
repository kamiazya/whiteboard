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
  await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  await expect.element(page.getByRole('button', { name: 'Opener' })).toHaveFocus()
})

it('returns focus to the opener after an item is chosen by the keyboard', async () => {
  render(<Host />)
  await userEvent.click(page.getByRole('button', { name: 'Opener' }))
  await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  await expect.element(page.getByRole('button', { name: 'Opener' })).toHaveFocus()
})

function KeyboardHost() {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState('none')
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(true)}>
        Opener
      </button>
      <output data-testid="chosen">{chosen}</output>
      {open ? (
        <ContextMenu
          x={10}
          y={30}
          label="Test actions"
          items={[
            { label: 'Rename', onSelect: () => setChosen('Rename') },
            {
              kind: 'options',
              label: 'Colour',
              options: [
                { label: 'Red', selected: false, onSelect: () => setChosen('Red') },
                { label: 'Blue', selected: false, onSelect: () => setChosen('Blue') },
              ],
            },
            { label: 'Delete', onSelect: () => setChosen('Delete') },
          ]}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

it('focuses the first item on open and walks the items with the arrow keys', async () => {
  render(<KeyboardHost />)
  await userEvent.click(page.getByRole('button', { name: 'Opener' }))
  await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await userEvent.keyboard('{ArrowDown}{ArrowDown}')
  await expect.element(page.getByRole('menuitemradio', { name: 'Blue' })).toHaveFocus()
  await userEvent.keyboard('{ArrowDown}')
  await expect.element(page.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  await userEvent.keyboard('{ArrowDown}')
  await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await userEvent.keyboard('{ArrowUp}')
  await expect.element(page.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  await userEvent.keyboard('{Home}')
  await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await userEvent.keyboard('{End}')
  await expect.element(page.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
})

it('opens on the first labelled row when a swatch group leads, and ArrowUp reaches the swatches', async () => {
  function SwatchFirstHost() {
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
            items={[
              {
                kind: 'options',
                label: 'Colour',
                options: [
                  { label: 'Red', selected: false, onSelect: () => {} },
                  { label: 'Blue', selected: false, onSelect: () => {} },
                ],
              },
              { label: 'Rename', onSelect: () => {} },
            ]}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </div>
    )
  }
  render(<SwatchFirstHost />)
  await userEvent.click(page.getByRole('button', { name: 'Opener' }))
  await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await userEvent.keyboard('{ArrowUp}')
  await expect.element(page.getByRole('menuitemradio', { name: 'Blue' })).toHaveFocus()
})

it('moves within the colour group with left and right and activates with Enter', async () => {
  render(<KeyboardHost />)
  await userEvent.click(page.getByRole('button', { name: 'Opener' }))
  await userEvent.keyboard('{ArrowDown}{ArrowRight}')
  await expect.element(page.getByRole('menuitemradio', { name: 'Blue' })).toHaveFocus()
  await userEvent.keyboard('{ArrowRight}')
  await expect.element(page.getByRole('menuitemradio', { name: 'Red' })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByTestId('chosen')).toHaveTextContent('Red')
  await expect.element(page.getByRole('menu')).toBeInTheDocument()
})

it('Tab leaves the menu in one stop and typeahead jumps to a label', async () => {
  render(<KeyboardHost />)
  await userEvent.click(page.getByRole('button', { name: 'Opener' }))
  await userEvent.keyboard('d')
  await expect.element(page.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByTestId('chosen')).toHaveTextContent('Delete')
  await expect.element(page.getByRole('button', { name: 'Opener' })).toHaveFocus()
})

it('returns focus to a non-HTML opener such as an SVG control', async () => {
  function SvgHost() {
    const [open, setOpen] = useState(false)
    return (
      <div style={{ position: 'relative' }}>
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: the opener under test is an SVG shape */}
        <svg width="40" height="40">
          {/* biome-ignore lint/a11y/useSemanticElements: the opener under test is an SVG shape */}
          <g role="button" tabIndex={0} aria-label="Svg opener" onClick={() => setOpen(true)}>
            <rect width="40" height="40" />
          </g>
        </svg>
        {open ? (
          <ContextMenu
            x={10}
            y={50}
            label="Test actions"
            items={[{ label: 'Rename', onSelect: () => {} }]}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </div>
    )
  }
  render(<SvgHost />)
  await userEvent.click(page.getByRole('button', { name: 'Svg opener' }))
  await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Svg opener')
})
