/**
 * Bytes an OLDER loro-crdt wrote must read the same under the installed one.
 *
 * Every keeper stores Loro bytes it will read back after an upgrade — the
 * daemon's snapshots and delta log, the browser's IndexedDB record, a saved
 * version — and a replica on the old version keeps shipping updates to one
 * on the new. A decode change would not fail anything else in this suite:
 * every other test reads bytes the installed version wrote a moment before.
 *
 * Each `fixtures/cross-version/loro-<version>/` entry was written by
 * `scripts/write-cross-version-fixture.ts` under THAT version, and its
 * `expected.json` is that version's own reading, so the oracle shares no
 * code with the decoder it judges. Add an entry before each bump by running
 * the script with the outgoing version still installed; never regenerate an
 * existing one.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Frontiers, LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { documentContainers, readWorkspaceDocuments } from './workspace-tree.js'

const CORPUS = fileURLToPath(new URL('../fixtures/cross-version/', import.meta.url))
const NOTE = '01ARZ3NDEKTSV4RRFFQ69G5F01'

interface Expected {
  loroVersion: string
  value: unknown
  frontiers: Frontiers
  midFrontiers: Frontiers
  midValue: unknown
  noteBodyDelta: unknown
}

const entries = readdirSync(CORPUS).filter((name) => name.startsWith('loro-'))

function bytes(entry: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(CORPUS, entry, file)))
}

function expectedOf(entry: string): Expected {
  return JSON.parse(readFileSync(join(CORPUS, entry, 'expected.json'), 'utf8'))
}

function imported(entry: string, file: string): LoroDoc {
  const doc = new LoroDoc()
  doc.import(bytes(entry, file))
  return doc
}

/** Frontiers are a set of heads; their array order carries no meaning. */
const asSet = (f: Frontiers) => f.map(({ peer, counter }) => `${counter}@${peer}`).sort()

describe('cross-version corpus', () => {
  it('contains the 1.13.6 compatibility fixture', () => {
    expect(entries).toContain('loro-1.13.6')
  })

  describe.each(entries)('%s', (entry) => {
    const expected = expectedOf(entry)

    it.each(['snapshot.bin', 'updates.bin'])('reads %s as the writing version did', (file) => {
      const doc = imported(entry, file)

      expect(doc.toJSON()).toEqual(expected.value)
      expect(asSet(doc.frontiers())).toEqual(asSet(expected.frontiers))
      expect(documentContainers(doc, NOTE).getText('body').toDelta()).toEqual(
        expected.noteBodyDelta,
      )
    })

    it.each(['snapshot.bin', 'updates.bin'])('checks %s out at an older version', (file) => {
      const doc = imported(entry, file)

      doc.checkout(expected.midFrontiers)

      expect(doc.toJSON()).toEqual(expected.midValue)
    })

    it('reads the shallow snapshot and the history it retained', () => {
      const doc = imported(entry, 'shallow-snapshot.bin')

      expect(doc.toJSON()).toEqual(expected.value)
      doc.checkout(expected.midFrontiers)
      expect(doc.toJSON()).toEqual(expected.midValue)
    })

    it('merges the old updates into a document that already holds the snapshot', () => {
      const doc = imported(entry, 'snapshot.bin')

      doc.import(bytes(entry, 'updates.bin'))

      expect(doc.toJSON()).toEqual(expected.value)
    })

    it('survives a re-export by the installed version', () => {
      const doc = new LoroDoc()

      doc.import(imported(entry, 'snapshot.bin').export({ mode: 'snapshot' }))

      expect(doc.toJSON()).toEqual(expected.value)
      expect(readWorkspaceDocuments(doc).map((d) => d.path)).toEqual([
        'notes/weekly',
        'archive',
        'archive/plan',
      ])
    })
  })
})
