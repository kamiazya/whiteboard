// The nodes an agent's last batch reached are outlined on the board, so a
// person sees what changed without diffing it by eye. Only the nodes named
// are outlined, and nothing is drawn when the set is empty.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'touched', x: 40, y: 40, width: 120, height: 60, text: 'moved by an agent' }),
    textNode({ id: 'untouched', x: 300, y: 40, width: 120, height: 60, text: 'left alone' }),
  ],
  edges: [],
}

function mount(agentTouchedNodeIds: ReadonlySet<string>) {
  return render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={() => {}}
        theme="light"
        agentTouchedNodeIds={agentTouchedNodeIds}
      />
    </div>,
  ).container
}

const outlines = (container: HTMLElement) =>
  container.querySelector('[data-testid="agent-touch-outlines"]')

it('outlines exactly the nodes an agent touched', async () => {
  const container = mount(new Set(['touched']))
  await vi.waitFor(() => expect(outlines(container)).not.toBeNull())
  const rects = [...(outlines(container)?.querySelectorAll('rect') ?? [])]
  expect(rects).toHaveLength(1)
  expect(rects[0]?.getAttribute('x')).toBe('40')
})

it('draws nothing when an agent touched nothing', async () => {
  const container = mount(new Set())
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'left alone',
    ),
  )
  expect(outlines(container)).toBeNull()
})
