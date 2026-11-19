/**
 * The two record kinds a workspace record can be held as, behind one set of
 * edits, so a test written once runs over both.
 *
 * Neither kind's own write surface is shared (a `LoroDoc` takes any container,
 * the engine takes named writers), so the one edit both can express is a
 * key/value line: a map entry on the document, a line in the markdown body on
 * the engine. Both converge under concurrent edits to different keys, which is
 * what the record tests merge.
 */
import {
  leaseKind,
  lease as leases,
  loadCrdtEngine,
  loroDocKind,
  type RecordKind,
  type RecordLease,
} from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'

export interface RecordSubject {
  readonly name: string
  readonly kind: RecordKind<unknown>
  /** An empty record on this kind. */
  fresh(): Promise<unknown>
  /** Writes `key` and commits it. */
  put(record: unknown, key: string, value: string): void
  get(record: unknown, key: string): string | undefined
  entries(record: unknown): Record<string, string>
}

const BODY = { query: 'markdownBody' as const }
const asText = { parse: (value: unknown) => value as string }

function parseLines(body: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) found[line.slice(0, at)] = line.slice(at + 1)
  }
  return found
}

const loroSubject: RecordSubject = {
  name: 'loroDocKind',
  kind: loroDocKind as RecordKind<unknown>,
  fresh: () => loroDocKind.empty(),
  put(record, key, value) {
    const doc = record as LoroDoc
    doc.getMap('meta').set(key, value)
    doc.commit()
  },
  get: (record, key) => (record as LoroDoc).getMap('meta').get(key) as string | undefined,
  entries: (record) => (record as LoroDoc).getMap('meta').toJSON() as Record<string, string>,
}

const leaseSubject: RecordSubject = {
  name: 'leaseKind',
  kind: leaseKind(loadCrdtEngine) as RecordKind<unknown>,
  fresh: () => leaseSubject.kind.empty(),
  put(record, key, value) {
    const held = record as RecordLease
    const body = leases.readNow(held, BODY, asText)
    leases.write(held, [{ op: 'writeMarkdownBody', args: { body: `${body}\n${key}=${value}` } }])
  },
  get: (record, key) => parseLines(leases.readNow(record as RecordLease, BODY, asText))[key],
  entries: (record) => parseLines(leases.readNow(record as RecordLease, BODY, asText)),
}

export const RECORD_SUBJECTS: readonly RecordSubject[] = [loroSubject, leaseSubject]
