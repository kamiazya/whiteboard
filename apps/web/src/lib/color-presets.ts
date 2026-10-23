import type { SpatialPresetKey } from '@kamiazya/whiteboard-canvas-render'

/**
 * The six preset colours a colour picker offers, in the order it lists them
 * and under the names it speaks. Shared by the node and edge colour rows and
 * the tag chip's colour menu, so one colour is never two names.
 */
export const presetEntries: readonly {
  readonly key: SpatialPresetKey
  readonly name: string
}[] = [
  { key: '1', name: 'Red' },
  { key: '2', name: 'Orange' },
  { key: '3', name: 'Yellow' },
  { key: '4', name: 'Green' },
  { key: '5', name: 'Cyan' },
  { key: '6', name: 'Purple' },
]
