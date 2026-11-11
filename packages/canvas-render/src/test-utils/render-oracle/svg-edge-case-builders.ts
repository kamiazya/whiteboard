import type { SceneLegend } from '@kamiazya/whiteboard-scene'
import type { SvgDocumentOptions } from '../../svg/backend.js'

/** The builders the SVG edge-case scenes are written with (`svg-edge-cases.ts`). */

export const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
export const box = (x: number, y: number, w = 40, h = 16) => ({ x, y, w, h })
export const run = (text: string, x = 0, y = 0, extra: object = {}) => ({
  kind: 'textRun',
  bbox: box(x, y),
  text,
  ...extra,
})
export const shape = (id: string | undefined, bbox = box(10, 10, 80, 50), extra: object = {}) => ({
  kind: 'shape',
  ...(id === undefined ? {} : { id }),
  bbox,
  ...extra,
})
export const edge = (id: string, path: [number, number][], extra: object = {}) => ({
  kind: 'edge',
  id,
  path: path.map(([x, y]) => ({ x, y })),
  fromSide: 'left',
  toSide: 'right',
  fromEnd: 'none',
  toEnd: 'arrow',
  ...extra,
})
export const paint = { fill: '#336699', stroke: '#112233', strokeWidth: 2 }
export const SKETCH = { style: 'sketch', seed: 4242 }
export const CORNER: [number, number][] = [
  [0, 0],
  [120, 0],
  [120, 70],
  [200, 70],
]
export const JUMPS = [
  { segment: 0, x: 40, y: 0 },
  { segment: 0, x: 80, y: 0 },
  { segment: 1, x: 120, y: 30 },
  { segment: 2, x: 160, y: 70 },
]

export const KEY_LEGEND: SceneLegend = {
  keys: [
    {
      key: 'status',
      of: 'boxes',
      entries: [
        { value: 'open', count: 3, swatch: { fill: '#aabbcc', stroke: '#112233' } },
        { value: 'done', count: 1, swatch: { fill: '#ccddee' } },
        { value: '', count: 2, swatch: {} },
      ],
    },
    {
      key: 'kind',
      of: 'edges',
      entries: [
        { value: 'blocks', count: 1, swatch: { stroke: '#cc0000' } },
        { value: 'relates to a very long value that widens the panel', count: 1, swatch: {} },
      ],
    },
  ],
  uncarried: { boxes: true, edges: true },
}

export type Case = {
  readonly id: string
  readonly nodes: readonly object[]
  readonly legend?: SceneLegend
  readonly options?: SvgDocumentOptions | null
}
