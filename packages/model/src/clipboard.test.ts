import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import {
  CLIPBOARD_FILES_MAX_BYTES,
  CLIPBOARD_FILES_MAX_COUNT,
  clipboardFragmentSchema,
} from './clipboard.js'

const NODE = textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: 'hi' })
const NODE2 = textNode({ id: 'n2', x: 200, y: 0, width: 100, height: 50, text: 'yo' })

describe('clipboardFragmentSchema', () => {
  it('accepts a typed fragment of nodes, edges, and inline file assets', () => {
    const fragment = {
      type: 'whiteboard/clipboard',
      version: 1,
      nodes: [
        NODE,
        NODE2,
        fileNode({ id: 'n3', x: 400, y: 0, width: 100, height: 50, file: 'asset:img' }),
      ],
      edges: [
        {
          id: 'e1',
          from: { node: 'n1' },
          to: { node: 'n2' },
        },
      ],
      files: {
        'asset:img': { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
      },
    }
    const parsed = clipboardFragmentSchema.parse(fragment)
    expect(parsed).toEqual(fragment)
  })

  it('accepts a minimal fragment without files', () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [NODE],
        edges: [],
      }).success,
    ).toBe(true)
  })

  it('rejects a wrong or missing discriminant/version (foreign JSON must not parse)', () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'excalidraw/clipboard',
        version: 1,
        nodes: [],
        edges: [],
      }).success,
    ).toBe(false)
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 2,
        nodes: [],
        edges: [],
      }).success,
    ).toBe(false)
    expect(clipboardFragmentSchema.safeParse({ nodes: [], edges: [] }).success).toBe(false)
  })

  it('rejects duplicate node ids and edges with endpoints missing from the fragment', () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [NODE, { ...NODE2, id: 'n1' }],
        edges: [],
      }).success,
    ).toBe(false)
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [NODE],
        edges: [
          {
            id: 'e1',
            from: { node: 'n1' },
            to: { node: 'ghost' },
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('accepts a cut fragment whose boundary edges each cross the selection border', () => {
    const fragment = {
      type: 'whiteboard/clipboard',
      version: 1,
      nodes: [NODE],
      edges: [],
      cut: {
        id: 'cut-1',
        // n1 is in the fragment; 'outside' is the peer left on the canvas.
        boundaryEdges: [
          {
            id: 'e-b',
            from: { node: 'n1' },
            to: { node: 'outside' },
          },
        ],
      },
    }
    expect(clipboardFragmentSchema.safeParse(fragment).success).toBe(true)
  })

  it('rejects a boundary edge that does not cross the border (both endpoints in, or none)', () => {
    const base = { type: 'whiteboard/clipboard', version: 1, nodes: [NODE, NODE2], edges: [] }
    expect(
      clipboardFragmentSchema.safeParse({
        ...base,
        cut: {
          id: 'cut-1',
          boundaryEdges: [
            {
              id: 'e-b',
              from: { node: 'n1' },
              to: { node: 'n2' },
            },
          ],
        },
      }).success,
    ).toBe(false)
    expect(
      clipboardFragmentSchema.safeParse({
        ...base,
        cut: {
          id: 'cut-1',
          boundaryEdges: [
            {
              id: 'e-b',
              from: { node: 'x' },
              to: { node: 'y' },
            },
          ],
        },
      }).success,
    ).toBe(false)
  })

  it('rejects extra keys and malformed file assets (strict envelope)', () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [],
        edges: [],
        surprise: true,
      }).success,
    ).toBe(false)
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [],
        edges: [],
        files: { k: { mimeType: '', dataBase64: 'x' } },
      }).success,
    ).toBe(false)
  })

  it("accepts the record of where the fragment's pictures live", () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [NODE],
        edges: [],
        source: { fileScope: 'daemon:http://127.0.0.1:1/w/a', copyId: 'c1' },
      }).success,
    ).toBe(true)
  })
})

describe('clipboardFragmentSchema file bounds', () => {
  const envelope = (files: Record<string, { mimeType: string; dataBase64: string }>) => ({
    type: 'whiteboard/clipboard',
    version: 1,
    nodes: [],
    edges: [],
    files,
  })
  // A padded base64 string of exactly `bytes` bytes, built without encoding them.
  const base64Of = (bytes: number) =>
    'AAAA'.repeat(Math.floor(bytes / 3)) + ['', 'AA==', 'AAA='][bytes % 3]

  it('accepts one picture at the bound and refuses one byte past it', () => {
    const atBound = base64Of(CLIPBOARD_FILES_MAX_BYTES)
    expect(
      clipboardFragmentSchema.safeParse(
        envelope({ 'asset:a': { mimeType: 'image/png', dataBase64: atBound } }),
      ).success,
    ).toBe(true)
    const pastBound = base64Of(CLIPBOARD_FILES_MAX_BYTES + 1)
    expect(
      clipboardFragmentSchema.safeParse(
        envelope({ 'asset:a': { mimeType: 'image/png', dataBase64: pastBound } }),
      ).success,
    ).toBe(false)
  })

  it('refuses pictures that fit one by one but not together', () => {
    const half = base64Of(CLIPBOARD_FILES_MAX_BYTES / 2 + 1)
    expect(
      clipboardFragmentSchema.safeParse(
        envelope({
          'asset:a': { mimeType: 'image/png', dataBase64: half },
          'asset:b': { mimeType: 'image/png', dataBase64: half },
        }),
      ).success,
    ).toBe(false)
  })

  it('refuses more pictures than a fragment carries', () => {
    const many = Object.fromEntries(
      Array.from({ length: CLIPBOARD_FILES_MAX_COUNT + 1 }, (_, i) => [
        `asset:${i}`,
        { mimeType: 'image/png', dataBase64: 'AAAA' },
      ]),
    )
    expect(clipboardFragmentSchema.safeParse(envelope(many)).success).toBe(false)
  })

  it('keys carried bytes by a stored-picture reference only', () => {
    expect(
      clipboardFragmentSchema.safeParse(
        envelope({ 'notes.md': { mimeType: 'image/png', dataBase64: 'AAAA' } }),
      ).success,
    ).toBe(false)
  })
})
