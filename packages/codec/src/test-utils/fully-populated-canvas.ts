import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'

/**
 * A canvas occupying every field position the model can hold.
 *
 * Shared by every format's ledger comparison, because the comparison is only
 * as strong as this: a position the fixture stopped covering would be missing
 * from BOTH sides of the equality and the guard would weaken rather than
 * break. One fixture is one place for that to be checked, and
 * `codecs.property.test.ts` checks it against the census on every run.
 */
export function fullyPopulatedCanvas(): SpatialCanvas {
  return {
    nodes: [
      textNode({
        id: 'n1',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        text: 'a',
        color: '1',
        facets: { 'visual.shape/v0': { kind: 'rect' } },
      }),
      fileNode({ id: 'n2', x: 1, y: 1, width: 2, height: 2, file: 'a.png', subpath: '#x' }),
      { id: 'n3', type: 'link', x: 2, y: 2, width: 2, height: 2, url: 'https://e.test/' },
      {
        // The embed rides the GROUP, which is the one node kind with no content
        // of its own for it to displace. On any other kind it takes the single
        // resource slot OCIF gives a node and the content moves onto an
        // extension — real, and a second variable this fixture does not want.
        id: 'n4',
        type: 'group',
        x: 3,
        y: 3,
        width: 4,
        height: 4,
        label: 'g',
        background: 'b.png',
        backgroundStyle: 'cover',
        embed: { documentId: '01M231FG6BGKKWW4BAA6Z1C945', versionRef: 'v1' },
      },
    ],
    edges: [
      {
        id: 'e1',
        from: { node: 'n1', side: 'right', end: 'none' },
        to: { node: 'n2', side: 'left', end: 'arrow' },
        color: '2',
        label: 'l',
        bends: [{ x: 1, y: 1 }],
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
      },
    ],
    lines: [
      // The free-ended element, and the only way to occupy the four `point`
      // positions. It is a LINE since ADR-0038 decision 2 — it was an edge
      // with a point end, which is ink wearing a relation's shape.
      {
        id: 'l1',
        from: { kind: 'point', point: { x: 42, y: -7 } },
        to: { kind: 'point', point: { x: 43, y: -8 } },
        color: '3',
        label: 'ink',
        bends: [{ x: 2, y: 2 }],
        facets: { 'visual.edges/v0': { routing: 'curved' } },
      },
      // One end on a node and one in space: what the editor's connect gesture
      // released in empty space makes, and the shape every reader of an end
      // has to handle.
      {
        id: 'l2',
        from: { kind: 'node', node: 'n3', side: 'top', end: 'none' },
        to: { kind: 'point', point: { x: 9, y: 9 }, end: 'arrow' },
      },
      // The mirror of l2, so both ENDS occupy both arms. An end's positions
      // are per side (`from` and `to` are separate rows in every ledger), so a
      // fixture that only ever attached its `from` would leave four of them
      // uncovered and weaken the comparisons in silence.
      {
        id: 'l3',
        from: { kind: 'point', point: { x: 4, y: 4 } },
        to: { kind: 'node', node: 'n1', side: 'bottom' },
      },
    ],
    comments: [
      {
        id: 'c1',
        x: 0,
        y: 0,
        text: 't',
        author: 'human:a',
        createdAt: '2026-01-01T00:00:00.000Z',
        targetNodeId: 'n1',
        resolved: false,
      },
      { id: 'c2', x: 1, y: 1, text: 'u', targetEdgeId: 'e1' },
    ],
    facets: { 'visual.theme/v0': { theme: 'sketch' } },
  }
}
