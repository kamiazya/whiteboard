import { constantRatioMeasureText, refusalCopy } from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CommentBody } from './CommentBody.js'

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

const CORE_UNAVAILABLE = { code: 'malformed', reason: 'core-unavailable' } as const

it('draws the comment again once a retry loads the core it said why without', () => {
  realm.core = fakeLayoutCore({
    markdown: { layoutMarkdown: () => ({ refused: CORE_UNAVAILABLE }) },
    query: { layoutQuery: () => ({ refused: CORE_UNAVAILABLE }) },
  })
  const { container } = render(
    <CommentBody body="Please tighten this" measure={constantRatioMeasureText} />,
  )
  const { title } = refusalCopy(CORE_UNAVAILABLE)
  expect(container.textContent).toContain(title)

  // The retry loaded it: the realm's core, which draws the comment.
  realm.core = testLayoutCore()
  realm.generation = 1
  act(() => {
    for (const listener of realm.listeners) listener()
  })
  expect(container.textContent).toContain('tighten')
  expect(container.textContent).not.toContain(title)
})
