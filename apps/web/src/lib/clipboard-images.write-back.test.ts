// A copy's deferred OS-clipboard rewrite, and a cross-scope paste over a
// selection that holds more than pictures. The rewrite is the only way
// picture bytes reach another tab or origin, and a same-tab paste reads the
// slot instead, so nothing else in the suite notices it going wrong.
import type { ClipboardFragment } from '@kamiazya/whiteboard-model'
import { nodeFile } from '@kamiazya/whiteboard-model'
import { fileNode, linkNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ClipboardImageSeams,
  transferFragmentImages,
  writeCarryingImages,
} from './clipboard-images.js'
import {
  carriedClipboardFiles,
  clearClipboardFragmentForTests,
  writeClipboardFragment,
} from './clipboard-store.js'

const png = () => new Blob([new Uint8Array(4)], { type: 'image/png' })

const pictureCopy = (): ClipboardFragment => ({
  type: 'whiteboard/clipboard',
  version: 1,
  nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 1, height: 1, file: 'asset:p' })],
  edges: [],
})

const seams = (readImage: ClipboardImageSeams['readImage']): ClipboardImageSeams => ({
  fileScope: 'scope-a',
  readImage,
  storeImage: async () => ({ ok: false, reason: 'not stored in these cases' }),
})

let clipboardDescriptor: PropertyDescriptor | undefined

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

/**
 * Copies, then resolves once the copy's own read has settled. The rewrite is
 * chained on that same promise first, so it has run by the time this does.
 */
async function copyAndSettle(
  readImage: ClipboardImageSeams['readImage'],
  between: () => void = () => {},
): Promise<void> {
  const stamped = writeCarryingImages(pictureCopy(), seams(readImage))
  const copyId = stamped.source?.copyId
  if (copyId === undefined) throw new Error('the copy was not stamped')
  const files = carriedClipboardFiles(copyId)
  if (files === undefined) throw new Error('the copy is not reading its pictures')
  between()
  await files
}

beforeEach(() => {
  clearClipboardFragmentForTests()
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
})

afterEach(() => {
  vi.restoreAllMocks()
  if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
})

describe('writeCarryingImages, the OS clipboard rewrite', () => {
  it('rewrites the OS clipboard once, carrying the bytes it read', async () => {
    const writeText = stubClipboard()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    await copyAndSettle(async () => png())

    expect(writeText).toHaveBeenCalledTimes(1)
    const written = JSON.parse(writeText.mock.calls[0]?.[0] ?? '{}')
    expect(Object.keys(written.files ?? {})).toEqual(['asset:p'])
  })

  it('does not rewrite it from a tab that no longer has focus', async () => {
    const writeText = stubClipboard()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    await copyAndSettle(async () => png())

    expect(writeText).not.toHaveBeenCalled()
  })

  it('does not rewrite it over a later copy', async () => {
    const writeText = stubClipboard()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    await copyAndSettle(
      async () => png(),
      () =>
        writeClipboardFragment({ type: 'whiteboard/clipboard', version: 1, nodes: [], edges: [] }),
    )

    expect(writeText).not.toHaveBeenCalled()
  })

  it('does not rewrite it when no picture could be read', async () => {
    const writeText = stubClipboard()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    await copyAndSettle(async () => undefined)

    expect(writeText).not.toHaveBeenCalled()
  })

  it('writes the fragment unstamped when there are no image seams', () => {
    const fragment = pictureCopy()
    expect(writeCarryingImages(fragment, undefined)).toBe(fragment)
  })
})

describe('transferFragmentImages over a mixed selection', () => {
  it('keeps a link and a non-picture file beside a picture', async () => {
    const { fragment } = await transferFragmentImages(
      {
        nodes: [
          fileNode({ id: 'f', x: 0, y: 0, width: 1, height: 1, file: 'asset:p' }),
          linkNode({ id: 'l', x: 0, y: 0, width: 1, height: 1, url: 'https://example.com' }),
          fileNode({ id: 'd', x: 0, y: 0, width: 1, height: 1, file: 'notes/a.md' }),
        ],
        edges: [],
        files: { 'asset:p': { mimeType: 'image/png', dataBase64: btoa('png') } },
      },
      {
        fileScope: 'scope-b',
        readImage: async () => undefined,
        storeImage: async () => ({ ok: true, ref: 'asset:new' }),
      },
    )

    expect(fragment.nodes.map((node) => node.id)).toEqual(['f', 'l', 'd'])
    const [picture, , file] = fragment.nodes
    expect(picture === undefined ? undefined : nodeFile(picture)).toBe('asset:new')
    expect(file === undefined ? undefined : nodeFile(file)).toBe('notes/a.md')
  })
})
