import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { loadOracleGlue } from '../../../vitest.oracle-glue.js'
import { isCoreTrap, isCoreUnrecoverable } from './core-trap.js'
import type { LayoutCoreHost } from './layout-core.js'
import { createLayoutCoreHost } from './layout-core.js'
import { renderCanvasToSvgWith } from './scene-render-core.js'
import type { WebCore } from './web-core.js'

/**
 * ADR-0054 QR-26c, the page half: a layout call that traps a REAL wasm instance
 * (the oracle artifact's deliberate trap) is drawn as the refusal notice for
 * that one call, and the next layout is answered by the instance the shim
 * reset. A real browser lane cannot carry this: the browser projects load the
 * shipped artifact, which has no trap, and only the `rust` job builds the
 * oracle. The realm-independent part (the core host and what it does with the
 * shim's own error classes) is what runs here; the worker and pool halves are
 * `layout-worker.core-trap.test.ts` and `layout-worker-pool.test.ts`.
 */

const host: { current: LayoutCoreHost | undefined } = vi.hoisted(() => ({ current: undefined }))
vi.mock('./layout-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./layout-core.js')>()),
  currentLayoutCore: () => host.current?.current(),
}))

interface OracleGlue {
  poison_instance(): void
}

const canvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 160, height: 60, text: 'still drawn' })],
  edges: [],
}

async function realm(traps: 'refuse' | 'throw') {
  const { glue: module, wasm } = await loadOracleGlue<OracleGlue & CoreGlue>()
  // The next layout call poisons the instance from inside the artifact, so the
  // trap surfaces through the shim's own guard and the instance is really reset.
  let trapNext = false
  const glue = {
    ...module,
    layout_spatial_canvas: (...args: Parameters<CoreGlue['layout_spatial_canvas']>) => {
      if (trapNext) {
        trapNext = false
        module.poison_instance()
      }
      return module.layout_spatial_canvas(...args)
    },
  } as unknown as CoreGlue
  const core = coreFrom(glue, wasm)
  host.current = createLayoutCoreHost(async () => core as unknown as WebCore, { traps })
  await host.current.ready()
  return {
    arm: () => {
      trapNext = true
    },
  }
}

const draw = () => renderCanvasToSvgWith(canvas, { measure: constantRatioMeasureText })

describe('a layout whose call trapped the real wasm instance', () => {
  it('draws the refusal notice for that call and the layout itself for the next', async () => {
    const { arm } = await realm('refuse')
    const before = draw()
    expect(before.scene.refusal).toBeUndefined()

    arm()
    const trapped = draw()
    expect(trapped.scene.refusal).toEqual({ code: 'malformed', reason: 'core-trapped' })
    expect(trapped.svg).not.toBe(before.svg)

    const after = draw()
    expect(after.scene.refusal).toBeUndefined()
    expect(after.svg).toBe(before.svg)
  })

  it('throws the shim’s own class in a worker realm, which the worker names a failure', async () => {
    const { arm } = await realm('throw')
    arm()
    let thrown: unknown
    try {
      draw()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).name).toBe('CoreInstanceTrapped')
    expect(isCoreTrap(thrown)).toBe(true)
    expect(isCoreUnrecoverable(thrown)).toBe(false)
    expect(draw().scene.refusal).toBeUndefined()
  })
})
