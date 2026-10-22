import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { typesetMdastBlocks } from './mdast-blocks.js'

const options = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }

const taskList = (checked: boolean): MdastRoot => ({
  type: 'root',
  children: [
    {
      type: 'list',
      ordered: false,
      children: [
        {
          type: 'listItem',
          checked,
          children: [{ type: 'paragraph', children: [{ type: 'text', value: 'ship it' }] }],
        },
      ],
    },
  ],
})

const itemOf = (checked: boolean) => {
  const list = typesetMdastBlocks(taskList(checked), options).nodes.find((n) => n.kind === 'list')
  const item = list?.kind === 'list' ? list.items[0] : undefined
  if (item === undefined) throw new Error('no item')
  return item
}

describe('a ticked task checkbox', () => {
  // A filled square inside the box read as "indeterminate", not done.
  it('holds a tick inside its frame, and no filled square', () => {
    const item = itemOf(true)
    const frame = item.children.find((c) => c.kind === 'shape')
    const tick = item.children.find((c) => c.kind === 'edge')
    if (frame?.kind !== 'shape' || tick?.kind !== 'edge') throw new Error('expected frame and tick')
    expect(item.children.filter((c) => c.kind === 'shape')).toHaveLength(1)
    expect(tick.path.length).toBeGreaterThanOrEqual(3)
    expect(tick.fromEnd).toBe('none')
    expect(tick.toEnd).toBe('none')
    for (const point of tick.path) {
      expect(point.x).toBeGreaterThan(frame.bbox.x)
      expect(point.x).toBeLessThan(frame.bbox.x + frame.bbox.w)
      expect(point.y).toBeGreaterThan(frame.bbox.y)
      expect(point.y).toBeLessThan(frame.bbox.y + frame.bbox.h)
    }
  })
})

describe('a task checkbox frame', () => {
  it('is marked as a task box carrying the item state, for a host to make clickable', () => {
    for (const checked of [false, true]) {
      const frame = itemOf(checked).children.find((c) => c.kind === 'shape')
      expect(frame?.kind === 'shape' ? frame.taskBox : undefined).toEqual({ checked })
    }
  })
})
