import { readFileSync } from 'node:fs'
import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { describe, expect, it } from 'vitest'
import type { CoreImpl, CoreMismatch, LayoutCore } from '../layout/edges/layout-core.js'
import {
  layoutCommentDocument,
  layoutMarkdownDocument,
  type MarkdownDocumentOptions,
} from '../layout/markdown-switch.js'
import { referenceSeamsFromWire } from '../references/wire.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import type { MarkdownMeta, MarkdownRecord } from '../test-utils/markdown-document-oracle/oracle.js'
import { built, requireWasm, wasmBytes } from '../test-utils/wasm/glue.js'

/**
 * S18a's note and comment recordings through canvas-render's markdown switch
 * over the REAL core, as a root lays a note or a comment out: under `differential` every note the
 * core answers is compared with the TypeScript and none may differ; under
 * `rust` the core's scene is what the caller gets, and it is the
 * TypeScript's. Only the bodies past the parser's bounds may be declined, and
 * nothing is skipped: every surface hands its options as data.
 */
const DIR = new URL('./', import.meta.url)
const SURFACES = ['daemon', 'preview', 'outline', 'thumbnail', 'comment'] as const

function surface(name: string): { meta: MarkdownMeta; records: MarkdownRecord[] } {
  const [head = '', ...lines] = readFileSync(new URL(`layout-markdown.${name}.jsonl`, DIR), 'utf8')
    .trimEnd()
    .split('\n')
  return { meta: JSON.parse(head) as MarkdownMeta, records: lines.map((l) => JSON.parse(l)) }
}

/** The options a root hands the switch for `record`, rebuilt from the record and its file's meta line. */
function optionsOf(record: MarkdownRecord, meta: MarkdownMeta): MarkdownDocumentOptions {
  const fonts = new Set(record.fonts ?? [])
  const style = record.surface === 'daemon' ? record.style : 'document'
  return {
    measure: createFakeMeasure(),
    maxWidth: record.maxWidth,
    mode: record.mode ?? 'light',
    ...(style === undefined ? {} : { style: style as MarkdownDocumentOptions['style'] }),
    ...(record.fonts === undefined ? {} : { fontAvailable: (family: string) => fonts.has(family) }),
    ...(record.references === true ? { references: referenceSeamsFromWire(meta.references) } : {}),
    ...(record.library === true ? { tagLibrary: meta.library } : {}),
    ...(record.fragments === undefined
      ? {}
      : { fragments: record.fragments === 'full' ? meta.fragments : [] }),
    ...(record.section === undefined ? {} : { section: record.section }),
  }
}

describe.runIf(built)('the recorded notes through the markdown switch', () => {
  const real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())

  const lay = (record: MarkdownRecord, meta: MarkdownMeta, impl: CoreImpl) => {
    const reports: CoreMismatch[] = []
    const core: LayoutCore = {
      routing: real,
      markdown: real,
      impl: { routeLayout: 'ts', layoutMarkdown: impl },
      onMismatch: (report) => reports.push(report),
    }
    if (record.surface === 'comment') {
      // As `CommentBody.tsx` lays a comment out: its measurer, width and density.
      const options = {
        measure: createFakeMeasure(),
        maxWidth: record.maxWidth,
        density: record.density ?? 'comfortable',
      } as const
      const scene = layoutCommentDocument(record.body, { ...options, core })
      return { scene, reference: layoutCommentDocument(record.body, options), reports }
    }
    const scene = layoutMarkdownDocument(record.body, { ...optionsOf(record, meta), core })
    const reference = layoutMarkdownDocument(record.body, optionsOf(record, meta))
    return { scene, reference, reports }
  }

  for (const name of SURFACES) {
    it(`answers every ${name} note as the TypeScript does`, { timeout: 120_000 }, () => {
      const { meta, records } = surface(name)
      const tally = new Map<string, number>()
      for (const record of records) {
        for (const impl of ['differential', 'rust'] as const) {
          const { scene, reference, reports } = lay(record, meta, impl)
          const classes = reports.map((r) =>
            r.kind === 'skipped' || r.kind === 'declined' ? `${r.kind}:${r.reason}` : r.kind,
          )
          for (const cls of classes.length === 0 ? ['answered'] : classes) {
            tally.set(`${impl} ${cls}`, (tally.get(`${impl} ${cls}`) ?? 0) + 1)
          }
          expect(
            classes.filter((c) => c === 'differs' || c === 'refused'),
            record.id,
          ).toEqual([])
          expect(scene, record.id).toEqual(reference)
        }
      }
      const counts = Object.fromEntries(tally)
      expect(Object.keys(counts).filter((k) => !/answered|declined:body/.test(k))).toEqual([])
      expect(counts['differential answered']).toBeGreaterThan(20)
      expect(counts['rust answered']).toBe(counts['differential answered'])
    })
  }
})
