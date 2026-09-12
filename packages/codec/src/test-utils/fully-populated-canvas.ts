import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

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
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        text: 'a',
        color: '1',
        facets: { 'visual.shape/v0': { kind: 'rect' } },
      },
      { id: 'n2', type: 'file', x: 1, y: 1, width: 2, height: 2, file: 'a.png', subpath: '#x' },
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
        from: { kind: 'node', node: 'n1', side: 'right', end: 'none' },
        to: { kind: 'node', node: 'n2', side: 'left', end: 'arrow' },
        color: '2',
        label: 'l',
        bends: [{ x: 1, y: 1 }],
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
      },
      // The free-ended edge, and the only way to occupy the four `point`
      // positions. A SECOND edge rather than a change to the first because the
      // comparisons need both: one the format can state, so its native
      // positions survive, and one it cannot, so the lost ones really are lost.
      {
        id: 'e2',
        from: { kind: 'point', point: { x: 42, y: -7 } },
        to: { kind: 'point', point: { x: 43, y: -8 } },
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
