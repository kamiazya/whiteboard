import { refusalCopy } from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { PreviewPane } from './PreviewPane.js'

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

it('draws the note again once a retry loads the core it drew the notice without', () => {
  realm.core = fakeLayoutCore({
    markdown: { layoutMarkdown: () => ({ refused: CORE_UNAVAILABLE }) },
  })
  const { container } = render(
    <PreviewPane theme="light" value="# Hello" maxWidth={480} measure={fakeMeasure} />,
  )
  const notice = refusalCopy(CORE_UNAVAILABLE)
  expect(container.textContent).toContain(notice.title)
  expect(container.textContent).not.toContain('Hello')

  // The retry loaded it: this realm has no core artifact, so the note is the
  // TypeScript composer's, which is what a realm with no core draws.
  realm.core = undefined
  realm.generation = 1
  act(() => {
    for (const listener of realm.listeners) listener()
  })
  expect(container.textContent).toContain('Hello')
  expect(container.textContent).not.toContain(notice.title)
})
