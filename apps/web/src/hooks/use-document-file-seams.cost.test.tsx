/**
 * What opening a board costs as its referenced notes land one at a time.
 *
 * Each load that lands re-runs the walk over what has loaded, and the editor
 * cuts the canvas's wire from the result. If every one of those passes reads
 * every loaded body again — scanning it for references and pictures, or
 * serialising it to compare wires by their bytes — then N notes cost N times
 * their total length on the main thread, and a board a member can legitimately
 * build (256 notes of 256K characters) freezes the tab while it opens.
 *
 * The instrument counts the characters the body scanners read (both forms
 * of the reference scanner, and the picture scanner) and the
 * characters `JSON.stringify` produces, against the total length of the
 * bodies, so the bound states the property directly: reading what loaded is
 * linear in what loaded.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCanvasReferences } from '../components/spatial-editor/use-canvas-references.js'
import type { DocumentFileAdapter, LoadedFileDocument } from '../lib/document-file-contract.js'
import { useDocumentFileSeams } from './use-document-file-seams.js'

const scanned = vi.hoisted(() => ({ references: 0, images: 0 }))

vi.mock('@kamiazya/whiteboard-codec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-codec')>()
  return {
    ...actual,
    scanReferences: (value: string) => {
      scanned.references += value.length
      return actual.scanReferences(value)
    },
    // The incremental form reads from the cursor to the end of what it found.
    findNextReference: (value: string, cursor: number) => {
      const match = actual.findNextReference(value, cursor)
      scanned.references +=
        (match === undefined ? value.length : match.index + match.full.length) - cursor
      return match
    },
  }
})

vi.mock('@kamiazya/whiteboard-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-model')>()
  return {
    ...actual,
    storedImageRefs: (content: Parameters<typeof actual.storedImageRefs>[0]) => {
      scanned.images += content.body?.length ?? 0
      return actual.storedImageRefs(content)
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const NOTES = 32
/** Long enough that a body read dwarfs everything else a pass touches. */
const BODY = `${'plain prose with no references in it. '.repeat(200)}[[note-0]]`

interface Deferred {
  readonly promise: Promise<LoadedFileDocument>
  readonly resolve: () => void
}

function deferredNote(ref: string): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<LoadedFileDocument>((settle) => {
    resolve = () => settle({ name: ref, body: BODY })
  })
  return { promise, resolve }
}

describe('opening a board whose notes land one at a time', () => {
  it('reads each loaded body a bounded number of times, not once per later load', async () => {
    const refs = Array.from({ length: NOTES }, (_, i) => `note-${i}`)
    const canvas: SpatialCanvas = {
      nodes: [
        textNode({
          id: 't',
          x: 0,
          y: 0,
          width: 400,
          height: 400,
          text: refs.map((ref) => `[[${ref}]]`).join(' '),
        }),
      ],
      edges: [],
    }
    const pending = new Map(refs.map((ref) => [ref, deferredNote(ref)]))
    const adapter: DocumentFileAdapter = {
      fileScope: 'test',
      isImageRef: (file) => file.startsWith('asset:'),
      loadDocument: vi.fn((ref: string) => {
        const note = pending.get(ref)
        return note === undefined ? Promise.resolve(undefined) : note.promise
      }),
      loadImageUrl: vi.fn(async (ref: string) => `blob:${ref}`),
      loadImageBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
      storeImage: vi.fn(async () => ({ ok: true as const, ref: 'asset:new' })),
    }
    const stampOf = new Map<string, string>()
    const bodies: readonly string[] = []
    const { result } = renderHook(() => {
      const { references } = useDocumentFileSeams({ canvas, adapter, stampOf, bodies })
      return useCanvasReferences(canvas, references)
    })
    await waitFor(() => expect(adapter.loadDocument).toHaveBeenCalledTimes(NOTES))

    scanned.references = 0
    scanned.images = 0
    const stringify = vi.spyOn(JSON, 'stringify')
    for (const [i, ref] of refs.entries()) {
      await act(async () => {
        pending.get(ref)?.resolve()
      })
      await waitFor(() => expect(result.current.wire?.entries.length).toBe(i + 1))
    }
    const stringified = stringify.mock.results.reduce(
      (sum, { value }) => sum + (typeof value === 'string' ? value.length : 0),
      0,
    )
    stringify.mockRestore()

    // Every note is drawn: the bound is not met by loading less.
    expect(result.current.wire?.entries.map(([key]) => key)).toEqual(refs)
    const loadedChars = NOTES * BODY.length
    // One reference scan and one picture scan per body is the floor; the
    // slack covers the canvas's own text, re-read on each pass.
    expect.soft(scanned.references).toBeLessThanOrEqual(2 * loadedChars)
    expect.soft(scanned.images).toBeLessThanOrEqual(2 * loadedChars)
    // Comparing or keying wires must not serialise the bodies they carry.
    expect.soft(stringified).toBeLessThanOrEqual(loadedChars)
  })
})
