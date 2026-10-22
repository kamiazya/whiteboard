import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from './backend.js'

const box = (taskBox?: { checked: boolean }): string =>
  renderSceneToSvg({
    nodes: [{ kind: 'shape', bbox: { x: 0, y: 0, w: 12, h: 12 }, ...(taskBox ? { taskBox } : {}) }],
  } as unknown as Scene)

describe('a task checkbox shape', () => {
  it('is painted as a checkbox carrying its state', () => {
    expect(box({ checked: true })).toContain('role="checkbox" aria-checked="true"')
    expect(box({ checked: false })).toContain('role="checkbox" aria-checked="false"')
  })

  it('leaves ordinary chrome without any role', () => {
    expect(box()).not.toContain('role=')
  })
})
