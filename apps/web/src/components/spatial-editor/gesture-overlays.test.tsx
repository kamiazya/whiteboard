// What an agent's last batch outlines on the board: nodes, edges, strokes
// (lines) and comment chrome. A touched id the scene has no geometry for
// draws nothing rather than a stray mark.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EditorGesture } from './editor-gesture.js'
import { GestureOverlays, type GestureOverlaysProps } from './gesture-overlays.js'

afterEach(cleanup)

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n', x: 0, y: 0, width: 100, height: 50, text: 'a' })],
  edges: [],
  lines: [
    {
      id: 'stroke',
      from: { kind: 'point', point: { x: 0, y: 100 } },
      to: { kind: 'point', point: { x: 90, y: 100 } },
    },
  ],
}

const gesture = {
  state: { kind: 'idle' },
  canvas,
  viewport: { x: 0, y: 0, zoom: 1 },
  livePoint: null,
} as unknown as EditorGesture

const BASE: GestureOverlaysProps = {
  gesture,
  tool: 'select',
  marquee: null,
  snapGuides: null,
  inkStroke: '#000',
  boxes: [{ id: 'n', box: { x: 0, y: 0, width: 100, height: 50 } }],
  cutIds: undefined,
  members: undefined,
  edgePaths: [
    {
      id: 'stroke',
      path: [
        { x: 0, y: 100 },
        { x: 90, y: 100 },
      ],
    },
  ],
  commentChromeBoxes: [
    { commentId: 'c1', part: 'pin', bbox: { x: 200, y: 10, w: 16, h: 16 } },
    { commentId: 'c1', part: 'bubble', bbox: { x: 220, y: 10, w: 80, h: 40 } },
    { commentId: 'c1', part: 'region', bbox: { x: 500, y: 10, w: 60, h: 60 } },
    { commentId: 'other', part: 'pin', bbox: { x: 400, y: 10, w: 16, h: 16 } },
  ],
  agentTouchedNodeIds: undefined,
  agentTouchedEdgeIds: undefined,
  agentTouchedLineIds: undefined,
  agentTouchedCommentIds: undefined,
}

const outlines = (props: Partial<GestureOverlaysProps>) =>
  render(<GestureOverlays {...BASE} {...props} />).container.querySelector(
    '[data-testid="agent-touch-outlines"]',
  )

describe('agent touch outlines', () => {
  it('outlines a touched line by its drawn path', () => {
    const svg = outlines({ agentTouchedLineIds: new Set(['stroke']) })
    expect(svg?.querySelector('polyline[data-edge-id="stroke"]')).not.toBeNull()
  })

  it('outlines the pin and bubble of a touched comment and no other comment', () => {
    const rects = [
      ...(outlines({ agentTouchedCommentIds: new Set(['c1']) })?.querySelectorAll('rect') ?? []),
    ]
    expect(
      rects.map((rect) =>
        ['x', 'y', 'width', 'height'].map((attr) => Number(rect.getAttribute(attr))),
      ),
    ).toEqual([
      [200, 10, 16, 16],
      [220, 10, 80, 40],
    ])
  })

  it('draws nothing for a touched id the scene has no geometry for', () => {
    const svg = outlines({
      agentTouchedLineIds: new Set(['gone']),
      agentTouchedCommentIds: new Set(['gone']),
    })
    expect(svg?.querySelectorAll('rect, polyline')).toHaveLength(0)
  })

  it('draws no outline layer when nothing was touched', () => {
    expect(outlines({})).toBeNull()
  })
})
