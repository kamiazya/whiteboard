// A dialog that edits ONE node holds that node's id, and the document can
// stop holding the node while the dialog is open — an undo, an import, a
// peer's delete. Both dialogs rendered on `!== null` alone, so they stayed
// open over nothing: the field showed empty instead of the current value,
// and OK wrote a command for a node that was gone, which `updateNode`
// answers by returning the same canvas. The user types, submits, the
// dialog closes, and nothing happened.
//
// Found by classifying SpatialEditor's state in
// `editor-state-surface.test.ts` — both are the id-pinned shape that had
// already cost two selection defects. The two label editors beside them
// resolve their node in the render and return null when it is missing;
// these now do the same, which is why the assertion is that the dialog is
// GONE rather than that some later write was refused.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    {
      id: 'l1',
      type: 'link',
      x: 100,
      y: 100,
      width: 200,
      height: 60,
      url: 'https://example.com/a',
    },
    { id: 'f1', type: 'file', x: 100, y: 300, width: 200, height: 60, file: 'notes/one.md' },
  ],
  edges: [],
}

function makeHost() {
  const latest: { canvas: SpatialCanvas; drop: (id: string) => void } = {
    canvas: start,
    drop: () => {},
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    const [externalVersion, setExternalVersion] = useState(0)
    latest.canvas = canvas
    latest.drop = (id) => {
      setCanvas((current) => ({ ...current, nodes: current.nodes.filter((n) => n.id !== id) }))
      setExternalVersion((v) => v + 1)
    }
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          externalVersion={externalVersion}
          onChange={(next) => setCanvas(next)}
          theme="light"
          fileRefOptions={[
            { file: 'notes/one.md', label: 'One' },
            { file: 'notes/two.md', label: 'Two' },
          ]}
        />
      </div>
    )
  }
  return { Host, latest }
}

function rightClick(root: HTMLElement, x: number, y: number) {
  const r = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: r.left + x,
      clientY: r.top + y,
    }),
  )
}

it('the Edit URL dialog closes when an undo removes the link it edits', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  rightClick(rootOf(container), 200, 130)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(page.getByRole('menuitem', { name: 'Edit URL' }))
  await expect.element(page.getByTestId('link-url-dialog')).toBeInTheDocument()

  latest.drop('l1')

  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="link-url-dialog"]')).toBeNull()
  })
})

it('the Change target dialog closes when an undo removes the file node it edits', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  rightClick(rootOf(container), 200, 330)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(page.getByRole('menuitem', { name: 'Change target' }))
  await expect.element(page.getByTestId('document-picker-dialog')).toBeInTheDocument()

  latest.drop('f1')

  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="document-picker-dialog"]')).toBeNull()
  })
})
