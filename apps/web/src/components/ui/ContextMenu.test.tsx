// @vitest-environment jsdom
/**
 * The menu's own behaviour, independent of any editor's catalog: the custom
 * colour picker's commit rule, the options row's toggle, the edge clamp, the
 * outside-press dismissal, and how the grid vessel chunks a mixed catalog.
 *
 * jsdom lays nothing out — `offsetParent` is always null and every box
 * measures zero — so the clamp case supplies the containing block and the
 * menu's size itself. Real-browser placement is the browser suites' job.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function colorRow(
  onPick: (hex: string) => void,
  custom: { value: string; selected: boolean } = { value: '#123456', selected: false },
): ContextMenuItem {
  return {
    kind: 'options',
    label: 'Color',
    options: [
      { label: 'Red', icon: <svg data-testid="red-glyph" />, selected: false, onSelect: () => {} },
    ],
    customColor: { ...custom, ariaLabel: 'Custom color', onPick },
  }
}

function openCustomColor(): HTMLElement {
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Custom color' }))
  return screen.getByTestId('custom-color-panel')
}

describe('ContextMenu custom colour', () => {
  it('opens the picker from the row and closes it on a second press', () => {
    render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={[colorRow(vi.fn())]}
        onClose={vi.fn()}
      />,
    )
    const trigger = screen.getByRole('menuitemradio', { name: 'Custom color' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('custom-color-panel')).toBeNull()
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('custom-color-panel')).not.toBeNull()
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('custom-color-panel')).toBeNull()
  })

  it('draws a selected custom colour as its own swatch, an unselected one as the hue wheel', () => {
    const { unmount } = render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={[colorRow(vi.fn(), { value: '#ff0000', selected: true })]}
        onClose={vi.fn()}
      />,
    )
    const swatch = () =>
      screen.getByRole('menuitemradio', { name: 'Custom color' }).querySelector('span')
    expect(
      screen.getByRole('menuitemradio', { name: 'Custom color' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(swatch()?.style.background).toBe('rgb(255, 0, 0)')
    unmount()
    render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={[colorRow(vi.fn(), { value: '#ff0000', selected: false })]}
        onClose={vi.fn()}
      />,
    )
    expect(swatch()?.style.background).not.toBe('rgb(255, 0, 0)')
  })

  it('commits each valid six-digit hex typed into the field', () => {
    const onPick = vi.fn()
    render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={[colorRow(onPick)]}
        onClose={vi.fn()}
      />,
    )
    openCustomColor()
    fireEvent.change(screen.getByLabelText('Hex color'), { target: { value: '#00ff00' } })
    expect(onPick).toHaveBeenCalledExactlyOnceWith('#00ff00')
  })

  it('never commits three-digit shorthand, from the field or on release', () => {
    const onPick = vi.fn()
    render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={[colorRow(onPick)]}
        onClose={vi.fn()}
      />,
    )
    const panel = openCustomColor()
    fireEvent.change(screen.getByLabelText('Hex color'), { target: { value: '#abc' } })
    fireEvent.pointerUp(panel)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('commits the draft on release only when it differs from the current colour', () => {
    const onPick = vi.fn()
    render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={[colorRow(onPick)]}
        onClose={vi.fn()}
      />,
    )
    const panel = openCustomColor()
    // Untouched draft: releasing over the panel is not an edit.
    fireEvent.pointerUp(panel)
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Hex color'), { target: { value: '#00ff00' } })
    fireEvent.pointerUp(panel)
    expect(onPick.mock.calls).toEqual([['#00ff00'], ['#00ff00']])
  })
})

describe('ContextMenu options row', () => {
  it('draws an option with an icon as that icon, named by its label', () => {
    const onSelect = vi.fn()
    render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={[
          {
            kind: 'options',
            label: 'Arrow',
            options: [
              {
                label: '→',
                ariaLabel: 'Arrow end',
                icon: <svg data-testid="arrow-glyph" />,
                selected: true,
                onSelect,
              },
            ],
          },
        ]}
        onClose={vi.fn()}
      />,
    )
    const option = screen.getByRole('menuitemradio', { name: 'Arrow end' })
    expect(option.querySelector('[data-testid="arrow-glyph"]')).not.toBeNull()
    fireEvent.click(option)
    expect(onSelect).toHaveBeenCalledOnce()
  })
})

describe('ContextMenu dismissal', () => {
  it('closes on a press outside the menu, and not on one inside it', () => {
    const onClose = vi.fn()
    render(
      <>
        <div data-testid="outside" />
        <ContextMenu
          label="Canvas actions"
          x={0}
          y={0}
          items={[{ label: 'Edit', onSelect: () => {} }]}
          onClose={onClose}
        />
      </>,
    )
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('ContextMenu edge clamp', () => {
  function layOut(
    parentSize: { width: number; height: number },
    menuSize: { width: number; height: number },
  ) {
    const parent = document.createElement('div')
    Object.defineProperty(parent, 'clientWidth', { value: parentSize.width })
    Object.defineProperty(parent, 'clientHeight', { value: parentSize.height })
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(parent)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect(menuSize),
    )
  }

  it('nudges a menu opened past the right and bottom edges back inside, by the margin', () => {
    layOut({ width: 300, height: 200 }, { width: 100.4, height: 50.2 })
    render(
      <ContextMenu
        label="Canvas actions"
        x={280}
        y={190}
        items={[{ label: 'Edit', onSelect: () => {} }]}
        onClose={vi.fn()}
      />,
    )
    const menu = screen.getByTestId('context-menu')
    // 300 - ceil(100.4) - 4, and 200 - ceil(50.2) - 4.
    expect(menu.style.left).toBe('195px')
    expect(menu.style.top).toBe('145px')
  })

  it('holds a menu that fits where it was asked, and pulls one past the top-left in to the margin', () => {
    layOut({ width: 300, height: 200 }, { width: 100, height: 50 })
    const { rerender } = render(
      <ContextMenu
        label="Canvas actions"
        x={40}
        y={30}
        items={[{ label: 'Edit', onSelect: () => {} }]}
        onClose={vi.fn()}
      />,
    )
    const menu = screen.getByTestId('context-menu')
    expect([menu.style.left, menu.style.top]).toEqual(['40px', '30px'])
    rerender(
      <ContextMenu
        label="Canvas actions"
        x={-20}
        y={-5}
        items={[{ label: 'Edit', onSelect: () => {} }]}
        onClose={vi.fn()}
      />,
    )
    expect([menu.style.left, menu.style.top]).toEqual(['4px', '4px'])
  })
})

describe('ContextMenu labelled vessels', () => {
  const items: ContextMenuItem[] = [
    { label: 'Edit', icon: <svg data-testid="edit-icon" />, onSelect: () => {} },
    { label: 'Duplicate', onSelect: () => {} },
    { kind: 'separator' },
    {
      kind: 'options',
      label: 'Shape',
      options: [{ label: 'Box', selected: true, onSelect: () => {} }],
    },
    { label: 'Delete', danger: true, onSelect: () => {} },
  ]

  it.each([
    'grid',
    'sheet',
  ] as const)('the %s vessel draws every verb as an icon-and-label row, like the list', (variant) => {
    render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={items}
        onClose={vi.fn()}
        variant={variant}
      />,
    )
    for (const name of ['Edit', 'Duplicate', 'Delete']) {
      const row = screen.getByRole('menuitem', { name })
      expect(row.textContent).toContain(name)
      expect(row.title).toBe('')
    }
    expect(screen.getByTestId('edit-icon')).toBeTruthy()
  })

  it('the sheet vessel gives each verb a 48px touch row', () => {
    render(
      <ContextMenu
        label="Canvas actions"
        x={0}
        y={0}
        items={items}
        onClose={vi.fn()}
        variant="sheet"
      />,
    )
    expect(screen.getByRole('menuitem', { name: 'Edit' }).className).toContain('min-h-12')
  })
})
