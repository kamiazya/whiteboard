import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { beforeAll, describe, expect, it } from 'vitest'
import { layoutMarkdownDocument } from '../layout/markdown-switch.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { testLayoutCore } from '../test-utils/test-layout-core.js'
import { built, requireWasm, wasmBytes } from '../test-utils/wasm/glue.js'
import { referenceSeamsFromWire, referenceWire } from './wire.js'

/**
 * A reference the page is still loading crosses the wire marked `pending`
 * (ADR-0054 step 7, S18g), so the Rust core draws an embed of it as the
 * TypeScript draws one it is told is loading: the placeholder that says so,
 * whether the body names it by id or by a path the alias table resolves.
 */
const ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

describe.runIf(built)('an embed still loading, through the real core', () => {
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })

  it.each([
    ['by id', `# Plan\n\n![[${ID}]]\n`],
    ['by path', '# Plan\n\n![[boards/roadmap]]\n'],
  ])('draws the loading placeholder as the TypeScript does, named %s', (_, body) => {
    const wire = referenceWire(new Map(), {
      resolveAlias: (alias) => (alias === 'boards/roadmap' ? ID : null),
      resolveTitle: (id) => (id === ID ? 'Roadmap' : undefined),
      pending: new Set([ID, 'boards/roadmap']),
    })
    const options = {
      measure: createFakeMeasure(),
      maxWidth: 480,
      references: referenceSeamsFromWire(wire),
    }
    const ts = layoutMarkdownDocument(body, { ...options, core: testLayoutCore() })
    expect(JSON.stringify(ts)).toContain('Loading…')
    const core = fakeLayoutCore({ markdown: real })
    expect(layoutMarkdownDocument(body, { ...options, core })).toEqual(ts)
  })
})
