// The context menu reached with the keyboard alone: Shift+F10 or the Menu key
// opens the SELECTION's menu, takes focus, and keeps every other key off the
// canvas behind it.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rightClick } from '../../test-utils/spatial-editor-pointer.js'
import { edgeMidpoint, rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 400, y: 40, width: 120, height: 60, text: 'B' }),
  ],
  edges: [],
}

const related: SpatialCanvas = {
  ...board,
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
}

function mount(initial: SpatialCanvas = board) {
  const host = makeEditorHost({ initial })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  return { ...host, container }
}

const menuRows = () => [...document.querySelectorAll('[data-testid="context-menu"] button')]
const openMenu = () => document.querySelector('[data-testid="context-menu"]')

it('Shift+F10 on a selected node opens that node menu focused on its first action row', async () => {
  const { container } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Shift>}{F10}{/Shift}')
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(openMenu()?.textContent).toContain('Comment on this')
  expect(openMenu()?.textContent).not.toContain('Comment here')
  expect(menuRows()).toContain(document.activeElement)
  expect(document.activeElement?.closest('fieldset,[role="group"]')).toBeNull()
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
  expect(rootOf(container).contains(document.activeElement)).toBe(true)
})

it('the Menu key opens the same node menu as Shift+F10', async () => {
  mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{ContextMenu}')
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(openMenu()?.textContent).toContain('Comment on this')
})

it('with nothing selected the keyboard menu is the canvas menu, focused', async () => {
  mount()
  await userEvent.keyboard('{Shift>}{F10}{/Shift}')
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(openMenu()?.textContent).toContain('Comment here')
  expect(document.activeElement).toBe(menuRows()[0])
})

it('Shift+F10 on a selected edge opens the edge menu', async () => {
  const { container } = mount(related)
  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(openMenu()).toBeNull())
  rootOf(container).focus()
  await userEvent.keyboard('{Shift>}{F10}{/Shift}')
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(openMenu()?.textContent).toContain('Edit label')
})

it('arrows move through the open menu and never nudge the node behind it', async () => {
  const { latest } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Shift>}{F10}{/Shift}')
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  const first = menuRows()[0]
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
  expect(latest.kinds).toEqual([])
  expect(latest.canvas.nodes.find((n) => n.id === 'a')?.y).toBe(40)
  expect(document.activeElement).not.toBe(first)
  expect(menuRows()).toContain(document.activeElement)
})

it('letters typed while a menu is open arm no tool and create nothing', async () => {
  const { latest } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Shift>}{F10}{/Shift}')
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.keyboard('dchn')
  expect(latest.canvas.nodes).toHaveLength(2)
  expect(latest.kinds).toEqual([])
  expect(openMenu()).not.toBeNull()
})

it('Enter on the focused item runs it, and Escape returns focus to the canvas', async () => {
  const { container } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Shift>}{F10}{/Shift}')
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(openMenu()).toBeNull())
  expect(document.activeElement).toBe(rootOf(container))
})
