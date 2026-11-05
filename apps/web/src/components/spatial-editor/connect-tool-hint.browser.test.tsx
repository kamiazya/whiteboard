// The Connect tool works by two presses, and nothing about an armed tool
// shows that: the canvas says what to do while the tool is armed, then what
// to do next once the first note is chosen, and a screen reader hears it once
// with the tool's name.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { canvasAnnouncement } from '../../lib/canvas-announcer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

beforeEach(async () => {
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe(''), { timeout: 4000 })
})

const twoNotes = {
  nodes: [
    textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 300, y: 40, width: 120, height: 60, text: 'B' }),
  ],
  edges: [],
}

it('shows what to press while Connect is armed, and nothing otherwise', async () => {
  const { Host } = makeEditorHost({ initial: twoNotes })
  render(<Host />)
  expect(page.getByTestId('connect-tool-hint').query()).toBeNull()

  await userEvent.click(page.getByRole('button', { name: 'Connect' }))
  await expect
    .element(page.getByTestId('connect-tool-hint'))
    .toHaveTextContent('Click the first note, then the second')
  await vi.waitFor(() =>
    expect(canvasAnnouncement()).toBe('Connect tool. Click the first note, then the second'),
  )

  await userEvent.click(page.getByRole('button', { name: 'Select' }))
  await expect.element(page.getByTestId('connect-tool-hint')).not.toBeInTheDocument()
})

it('asks for the second note once the first is chosen', async () => {
  const { Host } = makeEditorHost({ initial: twoNotes })
  const { container } = render(<Host />)
  await userEvent.click(page.getByRole('button', { name: 'Connect' }))
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 100,
    clientY: r.top + 70,
  })

  await expect
    .element(page.getByTestId('connect-tool-hint'))
    .toHaveTextContent('Now click the note to connect to')
})
