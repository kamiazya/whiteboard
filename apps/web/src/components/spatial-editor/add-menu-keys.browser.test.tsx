// The "+" menu's keyboard contract: Up/Down/Home/End move between entries.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'

afterEach(cleanup)

const empty: SpatialCanvas = { nodes: [], edges: [] }

it('arrow keys, Home and End move focus between the menu entries', async () => {
  const { Host } = makeEditorHost({ initial: empty })
  const { container } = render(<Host />)
  await userEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  const items = () => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const focused = () => items().indexOf(document.activeElement as HTMLElement)
  expect(items().length).toBeGreaterThan(2)
  await expect.poll(focused).toBe(0)
  await userEvent.keyboard('{ArrowDown}')
  await expect.poll(focused).toBe(1)
  await userEvent.keyboard('{ArrowUp}')
  await expect.poll(focused).toBe(0)
  await userEvent.keyboard('{ArrowUp}')
  await expect.poll(focused).toBe(items().length - 1)
  await userEvent.keyboard('{Home}')
  await expect.poll(focused).toBe(0)
  await userEvent.keyboard('{End}')
  await expect.poll(focused).toBe(items().length - 1)
})
