import { refusalCopy } from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { SpatialEditor } from './SpatialEditor.js'

// This realm's core as a test holds it: what `currentLayoutCore` answers,
// and the redraw tick a retry that loads it announces.
const realm = vi.hoisted(() => ({
  core: undefined as unknown,
  generation: 0,
  listeners: new Set<() => void>(),
}))
vi.mock('../../lib/spatial/layout-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/spatial/layout-core.js')>()),
  currentLayoutCore: () => realm.core,
  layoutCoreGeneration: () => realm.generation,
  subscribeLayoutCore: (listener: () => void) => {
    realm.listeners.add(listener)
    return () => realm.listeners.delete(listener)
  },
}))

// A fresh realm per run: a repeat that started at the last run's generation
// would announce no change, and the redraw it asserts would never be asked for.
afterEach(() => {
  cleanup()
  realm.core = undefined
  realm.generation = 0
  realm.listeners.clear()
})

/** What a layout draws when the realm's core did not load. */
const CORE_UNAVAILABLE = { code: 'malformed', reason: 'core-unavailable' } as const

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 160, height: 80, text: 'Ship' })],
  edges: [],
}

it('draws the board again once a retry loads the core it drew the notice without', () => {
  realm.core = fakeLayoutCore({
    layout: { layoutSpatialCanvas: () => ({ refused: CORE_UNAVAILABLE }) },
    query: { layoutQuery: () => ({ refused: CORE_UNAVAILABLE }) },
  })
  const { container } = render(
    <SpatialEditor theme="light" canvas={board} onChange={vi.fn()} measure={fakeMeasure} />,
  )
  const notice = () => container.querySelector('[data-testid="canvas-refusal-notice"]')
  expect(notice()?.textContent).toContain(refusalCopy(CORE_UNAVAILABLE).title)
  expect(container.textContent).not.toContain('Ship')

  // The retry loaded it: the realm's core, which draws the board.
  realm.core = testLayoutCore()
  realm.generation = 1
  act(() => {
    for (const listener of realm.listeners) listener()
  })
  expect(notice()).toBeNull()
  expect(container.textContent).toContain('Ship')
})
