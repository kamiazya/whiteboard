// The pure halves of carrying pictures across a paste: what a copy reads
// within the fragment's bound, and how a paste points each kind of picture —
// a picture node, a frame background, an inline image — at the target's copy.
import { MAX_FILE_UPLOAD_BYTES } from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import {
  bytesToBase64,
  CLIPBOARD_FILES_MAX_BYTES,
  clipboardFragmentSchema,
  frameBackground,
  nodeFile,
  nodeText,
} from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transferFragmentImages, writeCarryingImages } from './clipboard-images.js'
import { carriedClipboardFiles, clearClipboardFragmentForTests } from './clipboard-store.js'

const MiB = 1024 * 1024
const png = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/png' })

/** What a copy of picture nodes naming `refs` carries, read through `readImage`. */
async function carriedBy(
  refs: readonly string[],
  readImage: (ref: string) => Promise<Blob | undefined>,
) {
  const fragment = writeCarryingImages(
    {
      type: 'whiteboard/clipboard',
      version: 1,
      nodes: refs.map((file, i) =>
        fileNode({ id: `n${i}`, x: 0, y: 0, width: 1, height: 1, file }),
      ),
      edges: [],
    },
    { fileScope: 'a', readImage, storeImage: async () => ({ ok: false, reason: 'unused' }) },
  )
  const copyId = fragment.source?.copyId
  if (copyId === undefined) throw new Error('a copy naming pictures records its source')
  return (await carriedClipboardFiles(copyId)) ?? {}
}

beforeEach(clearClipboardFragmentForTests)

describe('the pictures a copy carries', () => {
  it('carries the largest picture any keeper accepts', () => {
    expect(CLIPBOARD_FILES_MAX_BYTES).toBeGreaterThanOrEqual(MAX_FILE_UPLOAD_BYTES)
  })

  it('reads pictures in order while they fit the bound, and skips the rest', async () => {
    const sizes: Record<string, number> = { 'asset:a': 9 * MiB, 'asset:b': 9 * MiB, 'asset:c': 3 }
    const files = await carriedBy(Object.keys(sizes), async (ref) => png(sizes[ref] ?? 0))
    expect(Object.keys(files)).toEqual(['asset:a', 'asset:c'])
    // What a copy writes is what the schema admits, so a paste can parse it back.
    const fragment = { type: 'whiteboard/clipboard', version: 1, nodes: [], edges: [], files }
    expect(clipboardFragmentSchema.safeParse(fragment).success).toBe(true)
  })

  it('skips a picture the keeper cannot read or that names no type', async () => {
    const files = await carriedBy(['asset:gone', 'asset:untyped', 'asset:ok'], async (ref) =>
      ref === 'asset:gone'
        ? undefined
        : ref === 'asset:untyped'
          ? new Blob([new Uint8Array(2)])
          : png(2),
    )
    expect(Object.keys(files)).toEqual(['asset:ok'])
  })
})

describe('transferFragmentImages', () => {
  const carried = { mimeType: 'image/png', dataBase64: btoa('png') }

  it('points every kind of picture at the stored copy', async () => {
    const storeImage = vi.fn(async (file: File) => ({
      ok: true as const,
      ref: `asset:new-${file.name}`,
    }))
    const { fragment, notice } = await transferFragmentImages(
      {
        nodes: [
          fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:p' }),
          groupNode({ id: 'g', x: 0, y: 0, width: 10, height: 10, background: 'asset:bg' }),
          textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: '![x](asset:p) asset:pp' }),
        ],
        edges: [],
        files: { 'asset:p': carried, 'asset:bg': carried },
      },
      { fileScope: 'b', readImage: async () => undefined, storeImage },
    )
    expect(notice).toBeNull()
    expect(storeImage).toHaveBeenCalledTimes(2)
    const [file, frame, text] = fragment.nodes
    expect(file && nodeFile(file)).toBe('asset:new-p')
    expect(frame && frameBackground(frame)).toBe('asset:new-bg')
    // Only the whole reference is rewritten; one that merely starts the same is another picture.
    expect(text && nodeText(text)).toBe('![x](asset:new-p) asset:pp')
  })

  it('leaves out what did not come along, keeping the frame without its background', async () => {
    const { fragment, notice } = await transferFragmentImages(
      {
        nodes: [
          fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:p' }),
          groupNode({ id: 'g', x: 0, y: 0, width: 10, height: 10, background: 'asset:bg' }),
        ],
        edges: [],
      },
      {
        fileScope: 'b',
        readImage: async () => undefined,
        storeImage: async () => ({ ok: false, reason: 'unused' }),
      },
    )
    expect(fragment.nodes.map((node) => node.id)).toEqual(['g'])
    expect(fragment.nodes[0] && frameBackground(fragment.nodes[0])).toBeUndefined()
    expect(notice).toContain('2 pictures were left out of the paste')
  })

  it("says the target keeper's own reason when it refuses a picture", async () => {
    const { notice } = await transferFragmentImages(
      {
        nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:p' })],
        edges: [],
        files: { 'asset:p': carried },
      },
      {
        fileScope: 'b',
        readImage: async () => undefined,
        storeImage: async () => ({ ok: false, reason: 'The daemon is full.' }),
      },
    )
    expect(notice).toBe('A picture was left out of the paste: The daemon is full.')
  })

  it('leaves out a picture whose carried bytes are not base64, storing nothing', async () => {
    const storeImage = vi.fn(async () => ({ ok: true as const, ref: 'asset:new' }))
    const { fragment, notice } = await transferFragmentImages(
      {
        nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:p' })],
        edges: [],
        files: { 'asset:p': { mimeType: 'image/png', dataBase64: 'not base64!' } },
      },
      { fileScope: 'b', readImage: async () => undefined, storeImage },
    )
    expect(storeImage).not.toHaveBeenCalled()
    expect(fragment.nodes).toEqual([])
    expect(notice).toContain('A picture was left out of the paste')
  })

  it('stores exactly the bytes the copy carried', async () => {
    const stored: File[] = []
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256)
    await transferFragmentImages(
      {
        nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:p' })],
        edges: [],
        files: { 'asset:p': { mimeType: 'image/png', dataBase64: bytesToBase64(bytes) } },
      },
      {
        fileScope: 'b',
        readImage: async () => undefined,
        storeImage: async (file) => {
          stored.push(file)
          return { ok: true, ref: 'asset:new' }
        },
      },
    )
    expect(stored.map((file) => [file.name, file.type, file.size])).toEqual([
      ['p', 'image/png', 300],
    ])
  })
})
