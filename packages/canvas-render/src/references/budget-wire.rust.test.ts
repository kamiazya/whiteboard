import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { beforeAll, describe, expect, it } from 'vitest'
import { layoutMarkdownDocument } from '../layout/markdown-switch.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { built, requireWasm, wasmBytes } from '../test-utils/wasm/glue.js'
import { REFERENCE_BUDGET, walkReferencesSync } from './targets.js'
import { referenceSeamsFromWire, referenceWire } from './wire.js'

/**
 * REFERENCE_BUDGET bounds what a render LOADS. A link resolved through the
 * caller's alias table loads nothing, so the wire carries the table's answer
 * for every link the document writes, and the Rust core draws link 300 the
 * way it draws link 1: a titled wiki link, not the raw `[[...]]` text.
 */
const idOf = (i: number) => `01BX5ZZKBKACTAV9WEVG${String(i).padStart(6, '0')}`
const COUNT = REFERENCE_BUDGET + 44

interface Run {
  readonly text?: string
  readonly link?: { readonly kind: string; readonly documentId?: string }
}

function runsOf(value: unknown, out: Run[] = []): Run[] {
  if (Array.isArray(value)) for (const item of value) runsOf(item, out)
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.kind === 'textRun') out.push(record as Run)
    for (const child of Object.values(record)) runsOf(child, out)
  }
  return out
}

describe.runIf(built)('links past the loading budget, through the real core', () => {
  // Made in `beforeAll`: vitest runs a skipped suite's factory to collect it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })

  it('draws a link the walk never loaded as a titled wiki link', () => {
    const body = `${Array.from({ length: COUNT }, (_, i) => `[[note-${i}]]`).join(' ')}\n`
    const graph = walkReferencesSync({ bodies: [body] }, () => null)
    expect(graph.size).toBe(REFERENCE_BUDGET)
    const wire = referenceWire(graph, {
      resolveAlias: (alias) => (alias.startsWith('note-') ? idOf(Number(alias.slice(5))) : null),
      resolveTitle: (id) => `Note ${Number(id.slice(20))}`,
      seeds: { bodies: [body] },
    })
    const scene = layoutMarkdownDocument(body, {
      measure: createFakeMeasure(),
      maxWidth: 480,
      references: referenceSeamsFromWire(wire),
      core: fakeLayoutCore({ markdown: real }),
    })
    const runs = runsOf(scene)
    for (const i of [0, REFERENCE_BUDGET, COUNT - 1]) {
      expect(runs).toContainEqual(
        expect.objectContaining({
          text: `Note ${i}`,
          link: { kind: 'wikiLink', documentId: idOf(i) },
        }),
      )
    }
    expect(runs.some((run) => run.text?.includes('[[note-'))).toBe(false)
  })
})
