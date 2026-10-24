// A selected frame's label opens from the keyboard the way the shortcut help
// promises, commits on Enter, and reopens with the name it now has.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g1', x: 80, y: 80, width: 360, height: 220, label: 'Release' }),
    textNode({ id: 'a', x: 120, y: 120, width: 120, height: 60, text: 'A' }),
  ],
  edges: [],
}

const editorOf = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('[data-testid="group-label-editor"]')

async function mountWithFrameSelected() {
  const host = makeEditorHost({ initial: board })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  await userEvent.keyboard('{Tab}')
  return { ...host, container }
}

it.each(['{Enter}', '{F2}'])('%s on a selected frame opens its label editor', async (key) => {
  const { container } = await mountWithFrameSelected()
  await userEvent.keyboard(key)
  await vi.waitFor(() => expect(editorOf(container)).not.toBeNull())
  expect(editorOf(container)?.value).toBe('Release')
})

it('Enter commits the label and a second edit starts from the new name', async () => {
  const { container, latest } = await mountWithFrameSelected()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(editorOf(container)).not.toBeNull())
  await userEvent.keyboard(' plan{Enter}')
  await vi.waitFor(() => expect(editorOf(container)).toBeNull())
  expect(latest.canvas.nodes[0]).toMatchObject({ label: 'Release plan' })
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(editorOf(container)).not.toBeNull())
  expect(editorOf(container)?.value).toBe('Release plan')
})
