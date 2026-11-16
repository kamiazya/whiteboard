/**
 * The live drag overlay reaches the Rust core (ADR-0054 step 7, S18d): every
 * pointer move re-lays the edges out through the core's query entry
 * (`edges`), and the frame titles the preview routes round come from it too
 * (`label-obstacles`), with the measurer the overlay memoises per gesture
 * named as the page's own, so the gate never skips a frame.
 *
 * The switch reports a query the core did not answer at debug, by class; this
 * counts them over a real drag and requires none, with the core asked for an
 * edge layer at least once. Under the CI browser job's `differential` +
 * `throw` a difference fails the frame; where no core is loaded the test
 * skips, and a run that asked for one (`differential` or `rust`,
 * `CORE_REQUIRED`) fails instead of skipping when the core did not load.
 */

import type { LayoutCore, QueryLayoutCore, QueryRequest } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { layoutCoreReady } from '../../lib/spatial/layout-core.js'
import { CORE_REQUIRED } from '../../test-utils/core-required.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const loaded: LayoutCore | undefined = await layoutCoreReady()
const QUERY = loaded?.impl.layoutQuery ?? 'ts'

it.runIf(CORE_REQUIRED)('loads the core the pipeline asked for before the overlay asks it', () => {
  expect(loaded?.query).toBeDefined()
})

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'f', x: 40, y: 20, width: 760, height: 320, label: 'Request path' }),
    textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'Alpha' }),
    textNode({ id: 'b', x: 500, y: 100, width: 120, height: 60, text: 'Beta' }),
    textNode({ id: 'c', x: 300, y: 240, width: 120, height: 60, text: 'Gamma' }),
  ],
  edges: [
    { id: 'ab', from: { node: 'a' }, to: { node: 'b', end: 'arrow' }, label: 'calls' },
    { id: 'bc', from: { node: 'b' }, to: { node: 'c', end: 'arrow' } },
  ],
}

const frame = () => new Promise((r) => requestAnimationFrame(r))

/** What the switch reports at debug: one `kind:reason` per query the core did not answer. */
function unanswered(): { readonly classes: string[]; readonly restore: () => void } {
  const classes: string[] = []
  const spy = vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
    const [message, report] = args as [string, { fn?: string; kind?: string; reason?: string }]
    if (typeof message === 'string' && message.includes('did not answer this layout')) {
      classes.push(`${report?.fn} ${report?.kind}:${report?.reason}`)
    }
  })
  return { classes, restore: () => spy.mockRestore() }
}

it.skipIf(QUERY === 'ts')('lays the drag overlay out through the core on every move', async () => {
  const query = (loaded as LayoutCore).query as QueryLayoutCore
  const asked = vi.spyOn(query, 'layoutQuery')
  const reports = unanswered()
  try {
    const { Host } = makeEditorHost({ initial: board, size: { width: 900, height: 700 } })
    const { container } = render(<Host />)
    const root = rootOf(container)
    const r = root.getBoundingClientRect()
    const at = (x: number, y: number) => ({
      pointerId: 7,
      clientX: r.left + x,
      clientY: r.top + y,
      buttons: 1,
    })
    fireEvent.pointerDown(root, at(160, 130))
    await frame()
    for (const [x, y] of [
      [190, 150],
      [220, 200],
      [260, 280],
    ] as const) {
      fireEvent.pointerMove(root, at(x, y))
      await frame()
    }
    await expect
      .poll(() => container.querySelector('[data-testid="live-edges"] polyline'))
      .not.toBeNull()
    const kinds = asked.mock.calls.map(([request]) => (request as QueryRequest).query)
    expect(kinds.filter((kind) => kind === 'edges').length).toBeGreaterThanOrEqual(3)
    expect(kinds).toContain('label-obstacles')
    expect(reports.classes.filter((c) => c.startsWith('layoutQuery'))).toEqual([])
  } finally {
    reports.restore()
    asked.mockRestore()
  }
})
