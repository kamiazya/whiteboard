// Regression for the top authoring defect: a node's stored height was
// authored at creation and never reconciled with the height the layout
// actually produces for the committed body, so normal short notes overflowed
// their border and overlapped neighbours. Contract pinned here: committing
// text GROWS the node to fit its laid-out content (grow-only — a roomy box
// stays at its authored size, and manual enlargement is never fought).
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { fillNodeEditor, nodeEditorContent } from './node-editor-test-utils.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const TALL_BODY = [
  '# Heading',
  '',
  '- first bullet point with some words',
  '- second bullet point with more words',
  '- third bullet point',
  '',
  'A closing paragraph line.',
].join('\n')

function makeHost(initial: SpatialCanvas) {
  const latest: { canvas: SpatialCanvas } = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

async function editNodeText(container: HTMLElement, text: string) {
  const root = rootOf(container)
  await userEvent.dblClick(root, { position: { x: 200, y: 130 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  fillNodeEditor(container, text)
  // Click far outside the node to blur-commit.
  await userEvent.click(root, { position: { x: 700, y: 500 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())
}

it('committing a tall body grows the node height to contain it', async () => {
  const { Host, latest } = makeHost({
    nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 60, text: 'hi' }],
    edges: [],
  })
  const { container } = render(<Host />)

  await editNodeText(container, TALL_BODY)

  const node = latest.canvas.nodes.find((n) => n.id === 'n1')
  expect(node?.type === 'text' ? node.text : undefined).toBe(TALL_BODY)
  // Seven laid-out lines cannot fit 60px; the box must have grown. The exact
  // value is measurement-dependent — the contract is containment, so assert
  // a clear lower bound rather than a golden number.
  expect(node?.height ?? 0).toBeGreaterThan(120)
  // Position and width are untouched by the grow.
  expect(node).toMatchObject({ x: 100, y: 100, width: 200 })
})

it('committing a short body into a roomy box leaves its height alone (grow-only)', async () => {
  const { Host, latest } = makeHost({
    nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 180, text: 'hello' }],
    edges: [],
  })
  const { container } = render(<Host />)

  await editNodeText(container, 'ok')

  const node = latest.canvas.nodes.find((n) => n.id === 'n1')
  expect(node?.type === 'text' ? node.text : undefined).toBe('ok')
  expect(node?.height).toBe(180)
})
