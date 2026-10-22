/**
 * The editor hands its lock set to the layout, so a locked node wears the
 * padlock the renderer draws — the lock was otherwise enforced but invisible.
 */

import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

const fakeMeasure = createFixedMeasure({ advance: 30, ascent: 10, descent: 2 })

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 20, y: 20, width: 100, height: 60, text: 'hello' }),
    textNode({ id: 'b', x: 250, y: 20, width: 100, height: 60, text: 'world' }),
  ],
  edges: [],
}

afterEach(() => {
  cleanup()
})

/** The x of every padlock `<use>` the editor drew. */
function padlockXs(container: HTMLElement): number[] {
  return [...container.querySelectorAll('use[href="#wb-icon-lock"]')].map((use) =>
    Number(use.getAttribute('x')),
  )
}

function mount(lockedNodeIds: ReadonlySet<string> | undefined, withToggle = true) {
  return render(
    <SpatialEditor
      theme="light"
      defaultTool="select"
      canvas={canvas}
      onChange={vi.fn()}
      measure={fakeMeasure}
      lockedNodeIds={lockedNodeIds}
      onToggleNodeLock={withToggle ? vi.fn() : undefined}
    />,
  ).container
}

describe('lock badge in the editor', () => {
  it('draws a padlock on the locked node and not on its neighbour', () => {
    const xs = padlockXs(mount(new Set(['a'])))
    expect(xs).toHaveLength(1)
    expect(xs[0]).toBeGreaterThan(20)
    expect(xs[0]).toBeLessThan(120)
  })

  it('draws none when nothing is locked', () => {
    expect(padlockXs(mount(new Set()))).toEqual([])
  })

  it('draws none when the host wired no unlock, since nothing is blocked either', () => {
    expect(padlockXs(mount(new Set(['a']), false))).toEqual([])
  })
})
