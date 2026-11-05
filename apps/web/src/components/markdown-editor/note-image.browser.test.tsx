/**
 * Attaching an image to a markdown note: the Image verb's picker, a paste and
 * a drop each store the file through the keeper's seam and write
 * `![name](asset:…)` at the caret, and the preview draws the stored picture.
 *
 * In a real browser because the intake is DOM events CodeMirror handles —
 * a paste's clipboard files, a drop's coordinates — and the claim at the end
 * is about what the preview's SVG draws.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { useReferenceSeams } from '../../hooks/use-reference-seams.js'
import type { ImageStoreResult } from '../../lib/document-file-contract.js'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { setViewport } from '../../test-utils/viewport.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PNG = () => new File([new Uint8Array([137, 80, 78, 71])], 'meter.png', { type: 'image/png' })

function Note({
  initial,
  store,
  onBody,
  generation = 0,
  loadImage = async (ref) => `blob:${ref}`,
}: {
  loadImage?: (ref: string) => Promise<string | undefined>
  initial: string
  store?: (file: File) => Promise<ImageStoreResult>
  onBody: (body: string) => void
  /** A new value remounts the editor, as a document switch or a CRDT rebind does. */
  generation?: number
}) {
  const [value, setValue] = useState(initial)
  const references = useReferenceSeams({
    body: value,
    load: async () => undefined,
    loadImage,
  })
  return (
    <div style={{ height: 500 }}>
      <MarkdownEditor
        key={generation}
        theme="light"
        value={value}
        onChange={(next) => {
          setValue(next)
          onBody(next)
        }}
        initialViewMode="split"
        measure={fakeMeasure}
        previewDebounceMs={0}
        references={references}
        {...(store === undefined ? {} : { onStoreImage: store })}
      />
    </div>
  )
}

async function mount(initial: string, store?: (file: File) => Promise<ImageStoreResult>) {
  await setViewport(1280, 800)
  const onBody = vi.fn()
  render(<Note initial={initial} store={store} onBody={onBody} />)
  const content = document.querySelector('.cm-content') as HTMLElement
  await userEvent.click(content)
  await userEvent.keyboard('{End}')
  return { onBody, content, last: () => onBody.mock.calls.at(-1)?.[0] as string | undefined }
}

const stored = (ref: string) => vi.fn(async (): Promise<ImageStoreResult> => ({ ok: true, ref }))
const previewHrefs = () =>
  [...document.querySelectorAll('[data-testid="markdown-preview-pane"] image, svg image')].map(
    (node) => node.getAttribute('href'),
  )

/** A store whose uploads finish only when the test says so, in any order. */
function held() {
  const waiting: ((result: ImageStoreResult) => void)[] = []
  return {
    store: vi.fn(
      (_file: File) => new Promise<ImageStoreResult>((resolve) => waiting.push(resolve)),
    ),
    pending: () => waiting.length,
    resolve: (index: number, ref: string) => waiting[index]?.({ ok: true, ref }),
  }
}

function filesOf(...files: File[]): DataTransfer {
  const data = new DataTransfer()
  for (const file of files) data.items.add(file)
  return data
}

/** A real picture of `width` x `height`, so the decode has a size to report. */
function pictureUrl(width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas.toDataURL('image/png')
}

describe('a picture alone in its paragraph', () => {
  it('is drawn at its natural size, not one line tall', async () => {
    await setViewport(1280, 800)
    const url = pictureUrl(320, 200)
    render(
      <Note initial={'Intro\n\n![d](asset:pic)'} onBody={() => {}} loadImage={async () => url} />,
    )
    await vi.waitFor(() => {
      const image = document.querySelector('[data-testid="markdown-preview-pane"] image')
      expect(image?.getAttribute('width')).toBe('320')
      expect(image?.getAttribute('height')).toBe('200')
    })
  })
})

describe('an image in a note', () => {
  it('is picked through the Image verb and drawn by the preview', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const store = stored('asset:pic')
    const { last } = await mount('Pump ok', store)

    await userEvent.click(await screen.findByRole('button', { name: 'Image…' }))
    expect(click).toHaveBeenCalled()
    const input = screen.getByLabelText('Choose an image') as HTMLInputElement
    input.files = filesOf(PNG()).files
    fireEvent.change(input)

    await vi.waitFor(() => expect(last()).toBe('Pump ok\n\n![meter](asset:pic)'))
    expect(store).toHaveBeenCalledWith(expect.objectContaining({ name: 'meter.png' }))
    await vi.waitFor(() => expect(previewHrefs()).toContain('blob:asset:pic'))
  })

  it('keeps words typed during the upload after the picture, caret at their end', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const upload = held()
    const { last } = await mount('Pump ok', upload.store)
    await userEvent.click(await screen.findByRole('button', { name: 'Image…' }))
    const input = screen.getByLabelText('Choose an image') as HTMLInputElement
    input.files = filesOf(PNG()).files
    fireEvent.change(input)
    await vi.waitFor(() => expect(upload.pending()).toBe(1))
    await userEvent.keyboard(' hello')
    upload.resolve(0, 'asset:late')
    await vi.waitFor(() => expect(last()).toBe('Pump ok\n\n![meter](asset:late)\n\n hello'))
    await userEvent.keyboard('!')
    await vi.waitFor(() => expect(last()).toBe('Pump ok\n\n![meter](asset:late)\n\n hello!'))
  })

  it('is offered in the editing catalog too', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    await mount('ab', stored('asset:c1'))
    await userEvent.click(screen.getByRole('button', { name: 'Editing actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Image…' }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('pasted from the clipboard lands at the caret', async () => {
    const { content, last } = await mount('ab', stored('asset:p1'))
    await userEvent.keyboard('{ArrowLeft}')
    fireEvent(
      content,
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: filesOf(PNG()),
      }),
    )
    await vi.waitFor(() => expect(last()).toBe('a\n\n![meter](asset:p1)\n\nb'))
  })

  it('pasted several at once keeps their order, a paragraph each', async () => {
    const upload = held()
    const { content, last } = await mount('ab', upload.store)
    const named = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/png' })
    fireEvent(
      content,
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: filesOf(named('one.png'), named('two.png')),
      }),
    )
    await vi.waitFor(() => expect(upload.pending()).toBe(2))
    upload.resolve(1, 'asset:two')
    upload.resolve(0, 'asset:one')
    await vi.waitFor(() => expect(last()).toBe('ab\n\n![one](asset:one)\n\n![two](asset:two)'))
  })

  it('dropped as a file is stored and written into the note', async () => {
    const { content, last } = await mount('ab', stored('asset:d1'))
    const box = content.getBoundingClientRect()
    fireEvent(
      content,
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: filesOf(PNG()),
        clientX: box.left + 2,
        clientY: box.top + 8,
      }),
    )
    await vi.waitFor(() => expect(last()).toMatch(/!\[meter\]\(asset:d1\)/))
  })

  it('says why when the keeper refuses the upload, and writes nothing', async () => {
    const store = vi.fn(
      async (): Promise<ImageStoreResult> => ({ ok: false, reason: 'Disk is full.' }),
    )
    const { content, onBody } = await mount('ab', store)
    fireEvent(
      content,
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: filesOf(PNG()),
      }),
    )
    await vi.waitFor(() =>
      expect(screen.getByTestId('note-image-notice').textContent).toContain('Disk is full.'),
    )
    expect(onBody).not.toHaveBeenCalled()
  })

  it('says so when an upload finishes after the editor was remounted', async () => {
    const upload = held()
    await setViewport(1280, 800)
    const onBody = vi.fn()
    const { rerender } = render(<Note initial="ab" store={upload.store} onBody={onBody} />)
    const content = document.querySelector('.cm-content') as HTMLElement
    fireEvent(
      content,
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: filesOf(PNG()),
      }),
    )
    await vi.waitFor(() => expect(upload.pending()).toBe(1))
    rerender(<Note initial="ab" store={upload.store} onBody={onBody} generation={1} />)
    upload.resolve(0, 'asset:orphan')
    await vi.waitFor(() =>
      expect(screen.getByTestId('note-image-notice').textContent).toContain('not added'),
    )
    expect(screen.getByTestId('note-image-notice').textContent).toContain('meter.png')
    expect(onBody).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await vi.waitFor(() => expect(screen.getByTestId('note-image-notice').textContent).toBe(''))
  })

  it('refuses a type the keeper cannot store before uploading it', async () => {
    const store = stored('asset:never')
    const { content } = await mount('ab', store)
    const heic = new File([new Uint8Array([1])], 'shot.heic', { type: 'image/heic' })
    fireEvent(
      content,
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: filesOf(heic),
      }),
    )
    await vi.waitFor(() =>
      expect(screen.getByTestId('note-image-notice').textContent).toContain('not supported'),
    )
    expect(store).not.toHaveBeenCalled()
  })

  it('is not offered where the host stores no files', async () => {
    await mount('ab')
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Image…' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Editing actions' }))
    await screen.findByRole('menuitem', { name: 'Bold' })
    expect(screen.queryByRole('menuitem', { name: 'Image…' })).toBeNull()
    expect(screen.queryByLabelText('Choose an image')).toBeNull()
  })
})
