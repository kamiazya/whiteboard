import { readFileSync } from 'node:fs'
import type { MarkdownDocumentOptions } from '../../layout/markdown-switch.js'
import { referenceSeamsFromWire } from '../../references/wire.js'
import { createFakeMeasure } from '../fake-measure.js'
import type { MarkdownMeta, MarkdownRecord } from './oracle.js'

const DIR = new URL('../../oracle/', import.meta.url)

/** One surface's recording: its meta line and its records. */
export function recordedSurface(name: string): { meta: MarkdownMeta; records: MarkdownRecord[] } {
  const [head = '', ...lines] = readFileSync(new URL(`layout-markdown.${name}.jsonl`, DIR), 'utf8')
    .trimEnd()
    .split('\n')
  return { meta: JSON.parse(head) as MarkdownMeta, records: lines.map((l) => JSON.parse(l)) }
}

/** The options a root hands the switch for `record`, rebuilt from the record and its file's meta line. */
export function noteOptionsOf(
  record: MarkdownRecord,
  meta: MarkdownMeta,
): Omit<MarkdownDocumentOptions, 'core'> {
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
