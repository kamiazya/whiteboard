// ADR-0029 decision 4's second half: the whole proposal is the default
// control, and expanding it decides one change at a time. "Nine of these are
// right and one is not" is the common case, and without this the only reply
// is to dismiss everything and ask again.
//
// The subject is the CARD — its disclosure, and that a per-change press
// decides exactly the change it names. That the write then closes that one
// change and leaves its sibling open is the session's half, covered by
// document-sync-session.test.ts.
import type { Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'the plan' },
    { id: 'n2', type: 'text', x: 0, y: 200, width: 120, height: 60, text: 'the risk' },
  ],
  edges: [],
}

const proposal: Proposal = {
  id: 'p1',
  createdAt: '2026-09-06T00:00:00.000Z',
  changes: [
    {
      id: 'node:n1',
      op: 'node.patch',
      status: 'open',
      nodeId: 'n1',
      patch: { x: 400 },
      assumed: { x: 0 },
    },
    {
      id: 'node:n2',
      op: 'node.patch',
      status: 'open',
      nodeId: 'n2',
      patch: { x: 600 },
      assumed: { x: 0 },
    },
  ],
}

function makeHost() {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          proposals={[proposal]}
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

/** A press on the bubble, found by the words it draws rather than by a guessed viewport. */
function pressBubble(root: HTMLElement) {
  const content = root.querySelector('[data-testid="canvas-content"]') as SVGElement
  const textEl = [...content.querySelectorAll('text')].find((el) =>
    el.textContent?.includes('proposed change'),
  ) as SVGTextElement
  const r = textEl.getBoundingClientRect()
  const at = { pointerId: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
}

it('expands to one verb pair per change, and adopting one decides only it', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await vi.waitFor(() =>
    expect(root.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      '2 proposed changes',
    ),
  )

  pressBubble(root)
  await expect.element(page.getByTestId('proposal-card')).toBeInTheDocument()
  // Collapsed by default: twenty proposed changes must not arrive as twenty
  // decisions, so the whole-proposal pair is what a reader meets first.
  expect(document.querySelector('[aria-label="Adopt: Move “the risk”"]')).toBeNull()
  await expect.element(page.getByRole('button', { name: 'Adopt 2 changes' })).toBeInTheDocument()

  await userEvent.click(page.getByRole('button', { name: 'Decide each change' }))
  await userEvent.click(page.getByRole('button', { name: 'Adopt: Move “the risk”' }))

  const decisions = latest.commands.filter((c) => c.kind === 'decide-proposal')
  expect(decisions).toHaveLength(1)
  const decision = decisions[0]
  if (decision?.kind !== 'decide-proposal') throw new Error('expected a decide-proposal command')
  expect(decision.decision).toBe('adopted')
  expect(decision.changes.map((c) => c.id)).toEqual(['node:n2'])
  expect(latest.canvas.nodes.find((n) => n.id === 'n2')?.x).toBe(600)
  expect(latest.canvas.nodes.find((n) => n.id === 'n1')?.x).toBe(0)
})
