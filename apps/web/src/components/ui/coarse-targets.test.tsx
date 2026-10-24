// @vitest-environment jsdom
// Menu rows, swatches and the dialog close step up to the 44px touch floor on
// a coarse pointer through `pointer-coarse:`. Chromium cannot emulate the media
// feature, so the contract is pinned on the classes that carry it.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TagChipsEditor } from '../tags/TagChipsEditor.js'
import { TagColouringProvider } from '../tags/tag-colouring.js'
import { ContextMenu } from './ContextMenu.js'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog.js'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu.js'

afterEach(cleanup)

const TOUCH_ROW = /pointer-coarse:min-h-11/

it.each(['list', 'grid'] as const)('a %s menu row is 44px high on a coarse pointer', (variant) => {
  render(
    <ContextMenu
      label="Actions"
      x={0}
      y={0}
      variant={variant}
      onClose={vi.fn()}
      items={[{ label: 'Copy', onSelect: vi.fn() }]}
    />,
  )
  expect(screen.getByRole('menuitem', { name: 'Copy' }).className).toMatch(TOUCH_ROW)
})

it('an options row swatch is a 44px target on a coarse pointer', () => {
  render(
    <ContextMenu
      label="Actions"
      x={0}
      y={0}
      onClose={vi.fn()}
      items={[
        {
          kind: 'options',
          label: 'Color',
          options: [{ label: 'Red', selected: false, onSelect: vi.fn() }],
          customColor: { value: '#123456', selected: false, ariaLabel: 'Custom', onPick: vi.fn() },
        },
      ]}
    />,
  )
  const group = screen.getByRole('group', { name: 'Color' })
  expect(group.className).toMatch(/pointer-coarse:\[&_button\]:min-h-11!/)
  expect(group.className).toMatch(/pointer-coarse:\[&_button\]:min-w-11!/)
})

it('dropdown rows, checkbox rows and sub triggers are 44px high on a coarse pointer', async () => {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>t</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Item</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>Check</DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Sub</DropdownMenuSubTrigger>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>,
  )
  expect((await screen.findByRole('menuitem', { name: 'Item' })).className).toMatch(TOUCH_ROW)
  expect(screen.getByRole('menuitemcheckbox', { name: 'Check' }).className).toMatch(TOUCH_ROW)
  expect(screen.getByRole('menuitem', { name: 'Sub' }).className).toMatch(TOUCH_ROW)
})

it('the dialog close button is a 44px target on a coarse pointer', () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>T</DialogTitle>
        <DialogDescription>D</DialogDescription>
      </DialogContent>
    </Dialog>,
  )
  const close = screen.getByRole('button', { name: 'Close' })
  expect(close.className).toMatch(/pointer-coarse:size-11/)
})

it('a tag chip and its remove control are 44px targets on a coarse pointer', () => {
  render(
    <TagColouringProvider setTagColour={vi.fn() as never}>
      <TagChipsEditor tags={['kind:service']} onChange={vi.fn()} />
    </TagColouringProvider>,
  )
  expect(screen.getByRole('button', { name: 'Tag kind:service menu' }).className).toMatch(
    /pointer-coarse:min-h-11/,
  )
  expect(screen.getByRole('button', { name: 'Remove tag kind:service' }).className).toMatch(
    /pointer-coarse:size-11/,
  )
})
