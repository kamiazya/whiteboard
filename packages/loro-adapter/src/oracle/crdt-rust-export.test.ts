import { readFileSync } from 'node:fs'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { frontierPairs, type VersionPairs, versionPairs } from '../engine/answers.js'

/**
 * The Rust-to-JavaScript half of ADR-0054's bidirectional fixtures: documents
 * built and exported by the Rust `loro` crate (`crates/core/crdt/tests/
 * rust_to_js.rs` writes the corpus), imported here through npm `loro-crdt`.
 * Held by value — the deep value, the version vector and the frontiers the
 * Rust side recorded — never by snapshot bytes, which are not canonical.
 */
const FILE = new URL('./crdt-rust-export.jsonl', import.meta.url)

interface Row {
  id: string
  snapshot: string
  updates: string
  shallow: string
  deep: unknown
  vv: VersionPairs
  frontiers: Array<[string, number]>
}

const rows: Row[] = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Row)

const imported = (b64: string) => {
  const doc = new LoroDoc()
  doc.import(new Uint8Array(Buffer.from(b64, 'base64')))
  return doc
}

describe('what the Rust loro crate exports, read by npm loro-crdt', () => {
  it('holds every Rust-written shape', () => {
    expect(rows.map((row) => row.id)).toEqual([
      'rust-empty',
      'rust-map-scalars',
      'rust-list-nested',
      'rust-text-utf16',
      'rust-text-marks',
      'rust-movable-list',
      'rust-tree',
      'rust-counter',
      'rust-concurrent',
      'rust-deleted',
      'rust-workspace-shaped',
    ])
    expect(rows.filter((row) => row.vv.length >= 2).length, 'rows merged from two peers').toBe(1)
  })

  it.each(rows.map((row) => [row.id, row] as const))('%s', (_id, row) => {
    for (const export_ of ['snapshot', 'updates', 'shallow'] as const) {
      const doc = imported(row[export_])
      expect(doc.toJSON(), `${export_} deep value`).toEqual(row.deep)
      expect(frontierPairs(doc.frontiers()), `${export_} frontiers`).toEqual(row.frontiers)
      if (export_ !== 'shallow') {
        expect(versionPairs(doc.oplogVersion()), `${export_} version vector`).toEqual(row.vv)
      }
    }
  })
})
