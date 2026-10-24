import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { SpatialEditorPane } from './SpatialEditorPane.js'

beforeEach(() => sessionStorage.clear())
afterEach(cleanup)

function Pane({ initial }: { initial: SpatialCanvas }) {
  const [canvas, setCanvas] = useState(initial)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditorPane
        editorKey="doc"
        canvasLoaded
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
        fileSeams={{
          references: { entries: [], aliases: [], titles: [], extras: [] },
          onAddImage: () => Promise.reject(new Error('unused')),
          isImageFileRef: () => false,
          clipboardImages: {
            fileScope: 'test',
            readImage: async () => undefined,
            storeImage: () => Promise.reject(new Error('unused')),
          },
        }}
        nodeInEditor={{
          open: () => {},
          editing: null,
          commit: () => {},
          close: () => {},
          draft: () => {},
          draftBodies: [],
        }}
        onOpenDocument={() => {}}
        history={{ onUndo: () => {}, onRedo: () => {}, canUndo: false, canRedo: false }}
        overlayTitle="Board"
        linkTargets={[]}
        className="pane"
      />
    </div>
  )
}

const withNode: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 100, y: 100, width: 100, height: 60, text: 'A' })],
  edges: [],
}
const pressed = (name: string) =>
  page.getByRole('button', { name }).element().getAttribute('aria-pressed')

it('keeps Select after notes are added to an empty board', async () => {
  render(<Pane initial={{ nodes: [], edges: [] }} />)
  await expect.poll(() => pressed('Select')).toBe('true')
  fireEvent.click(page.getByRole('button', { name: 'Add' }).element())
  fireEvent.click(page.getByRole('menuitem', { name: 'Note' }).element())
  expect(pressed('Select')).toBe('true')
  expect(pressed('Hand (pan)')).toBe('false')
})

it('reopens a board that has content in the tool the user picked', async () => {
  const first = render(<Pane initial={withNode} />)
  fireEvent.click(page.getByRole('button', { name: 'Select' }).element())
  expect(pressed('Select')).toBe('true')
  first.unmount()
  render(<Pane initial={withNode} />)
  expect(pressed('Select')).toBe('true')
})
