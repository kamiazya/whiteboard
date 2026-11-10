import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  readDeclineEarned,
  writeDeclineEarned,
} from '../../test-utils/json-canvas-oracle/earned.js'
import {
  canvasOf,
  decodeRecording,
  type Issues,
  type ReaderCase,
  readerCase,
  type WriterCase,
  writerCase,
} from '../../test-utils/json-canvas-oracle/oracle.js'
import { readJsonCanvasText } from '../read-json-canvas-text.js'
import { parseSpatial, serializeSpatial } from '../spatial-core.js'

/**
 * The committed recording of the JSON Canvas codec's answers, which the Rust
 * crate replays natively (`crates/core/codec/tests/json_canvas_oracle.rs`),
 * equals what the core answers through its wasm shim, and what the viewer's
 * TypeScript reader answers. It was taken from the TypeScript codec before its
 * writer was deleted and is frozen: it holds the inputs as well as the answers,
 * so these tests need no generator, and a change that moves an answer must say
 * so by editing the recording by hand.
 *
 * Message text is not recorded: the Rust port words its refusals in its own
 * types, so the readers agree on the stage and, for a schema refusal, each Zod
 * issue's path and code. A call the core declines (a lone surrogate, nesting
 * past its reader, a link whose host needs tables it lacks) is held to the
 * inputs that earn it, judged without the core (`earned.ts`); the viewer reader
 * declines nothing.
 */
const FILE = new URL('./json-canvas.jsonl', import.meta.url)

describe('the recorded JSON Canvas oracle', () => {
  const recorded = decodeRecording(readFileSync(FILE, 'utf8'))
  const readers = recorded.filter((c): c is ReaderCase => c.k === 'r')
  const writers = recorded.filter((c): c is WriterCase => c.k === 'w')

  it('reaches the answers the Rust port is held to', () => {
    const schema = readers.flatMap((c) =>
      'err' in c && 'issues' in c.err ? [c.err.issues as Issues] : [],
    )
    const codes = new Set(schema.flatMap((issues) => issues.map(([, code]) => code)))
    for (const code of [
      'invalid_type',
      'too_small',
      'too_big',
      'invalid_format',
      'invalid_value',
      'invalid_union',
      'custom',
    ]) {
      expect(codes.has(code), `an issue coded ${code}`).toBe(true)
    }
    expect(readers.filter((c) => 'ok' in c).length, 'accepted documents').toBeGreaterThan(400)
    expect(schema.length, 'documents refused by the schema').toBeGreaterThan(300)
    const stage = (name: string) => readers.filter((c) => 'err' in c && c.err.stage === name)
    expect(stage('json-syntax').length, 'texts that are not JSON').toBeGreaterThan(40)
    expect(
      readers.filter((c) => 'err' in c && 'class' in c.err && c.err.class === 'conversation')
        .length,
      'files carrying comments',
    ).toBeGreaterThan(3)
    const accepted = (needle: string) =>
      readers.filter((c) => 'ok' in c && JSON.stringify(c.ok).includes(needle)).length
    for (const needle of [
      '"lines"',
      '"embed"',
      '"bends"',
      '"facets"',
      '"tags"',
      '"backgroundStyle"',
    ]) {
      expect(accepted(needle), `accepted documents with ${needle}`).toBeGreaterThan(20)
    }
    expect(writers.filter((c) => 'y' in c).length, 'written canvases').toBeGreaterThan(400)
    expect(
      writers.filter((c) => 'err' in c).length,
      'canvases the strict mode refuses',
    ).toBeGreaterThan(40)
    expect(writers.filter((c) => c.m === 'strict').length, 'strict writes').toBeGreaterThan(250)
  })

  it('reads every recorded text through the core as recorded, declining only what it may', () => {
    const declined: string[] = []
    for (const recording of readers) {
      const answer = readerCase(parseSpatial, recording.t)
      if ('declined' in answer) {
        expect(
          readDeclineEarned(answer.declined, recording.t),
          `declined as ${answer.declined}`,
        ).toBe(true)
        declined.push(answer.declined)
      } else {
        expect(answer, recording.t.slice(0, 400)).toEqual(recording)
      }
    }
    // The decline is the exception: most texts are answered, and each class is met.
    expect(declined.length, 'declined texts').toBeLessThan(readers.length / 15)
    for (const reason of ['lone-surrogate', 'url', 'too-deep']) {
      expect(declined, `a text declined as ${reason}`).toContain(reason)
    }
  })

  it('writes every recorded canvas through the core as recorded, declining only a link', () => {
    let declined = 0
    for (const recording of writers) {
      const answer = writerCase(serializeSpatial, recording.c, recording.m)
      if ('declined' in answer) {
        expect(writeDeclineEarned(answer.declined, canvasOf(recording.c))).toBe(true)
        declined++
      } else {
        expect(answer).toEqual(recording)
      }
    }
    expect(declined, 'declined canvases').toBeGreaterThan(0)
    expect(declined, 'declined canvases').toBeLessThan(writers.length / 15)
  })

  it('reads every recorded text through the viewer reader as recorded, declining nothing', () => {
    const parted = readers.findIndex(
      (c) => JSON.stringify(readerCase(readJsonCanvasText, c.t)) !== JSON.stringify(c),
    )
    expect(parted, 'the first recorded text the viewer reader no longer reads as recorded').toBe(-1)
  })
})
