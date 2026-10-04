// The nodes an agent's last batch reached are outlined on the board, so a
// person sees what changed without diffing it by eye. Only the nodes named
// are outlined — nodes, strokes and comment chrome alike — and nothing is
// drawn when the sets are empty.

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
  lines: [
    {
      id: 'stroke',
      from: { kind: 'point', point: { x: 40, y: 200 } },
      to: { kind: 'point', point: { x: 200, y: 260 } },
    },
  ],
  comments: [
    {
      id: 'note',
      x: 400,
      y: 300,
      text: 'agent remark',
      createdAt: '2026-09-02T00:00:00.000Z',
    },
  ],
}

function mount(
  agentTouchedNodeIds: ReadonlySet<string>,
  extra: {
    readonly agentTouchedLineIds?: ReadonlySet<string>
    readonly agentTouchedCommentIds?: ReadonlySet<string>
  } = {},
) {
  return render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={() => {}}
        theme="light"
        agentTouchedNodeIds={agentTouchedNodeIds}
        {...extra}
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

it('outlines a stroke an agent drew when no node was touched', async () => {
  const container = mount(new Set(), { agentTouchedLineIds: new Set(['stroke']) })
  await vi.waitFor(() =>
    expect(outlines(container)?.querySelector('polyline[data-edge-id="stroke"]')).not.toBeNull(),
  )
})

it('outlines the pin of a comment an agent left when no node was touched', async () => {
  const container = mount(new Set(), { agentTouchedCommentIds: new Set(['note']) })
  await vi.waitFor(() =>
    expect(outlines(container)?.querySelectorAll('rect').length).toBeGreaterThan(0),
  )
})
