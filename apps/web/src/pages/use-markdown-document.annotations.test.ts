/**
 * A markdown document's conversations, read off the host the hook already
 * holds (ADR-0026 step 3).
 *
 * The gap this closes: the page gives a markdown document NO BrowserBackend
 * on purpose — the spatial sync layer persists a body-less doc to the same
 * id, and two writers for one id are last-writer-wins, so it would clobber
 * the body this hook writes. That decision left `useDocumentSync` idle, and
 * with it the annotation channel, so the rail on a markdown document was
 * permanently empty and its opener permanently read `0`. Threads stored on
 * such a document were reachable by an MCP peer and by nothing in the app.
 *
 * So the reader lives here instead, on the doc that is already open: the
 * threads plane is a peer of `body`, not something inside a canvas envelope,
 * which is exactly what `readAnnotations` was extracted to say.
 */
import {
  writeCommentThread,
  writeMarkdownBody,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type Loro, LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LoroStoreLike } from './use-browser-document-controller.js'
import { useMarkdownDocument } from './use-markdown-document.js'

/**
 * A store holding one document, seeded with whatever the caller wrote into a
 * real Loro doc. Real bytes rather than a placeholder: the subject is what
 * `readAnnotations` finds in the loaded document, so a fake that never round
 * trips through loro-crdt would assert nothing about it.
 */
function storeHolding(seed: (doc: Loro) => void): LoroStoreLike {
  const doc = new LoroDoc()
  seed(doc)
  const snapshot = doc.export({ mode: 'snapshot' })
  return {
    async save() {},
    createEmptySnapshot() {
      return new Uint8Array()
    },
    async load() {
      return { kind: 'ok', snapshot } as never
    },
  }
}

describe('useMarkdownDocument annotations', () => {
  it('answers with the conversations stored on the document', async () => {
    const store = storeHolding((doc) => {
      writeCommentThread(doc, {
        id: 't-open',
        // A text anchor is the markdown-native shape; the reader is anchor
        // agnostic, and using one here keeps the case honest about the
        // document kind it is about.
        anchor: { kind: 'text', quote: { exact: 'the second paragraph' }, start: 12, end: 32 },
        status: 'open',
        messages: [{ id: 'm1', body: 'is this still true?' }],
      })
    })

    const { result } = renderHook(() => useMarkdownDocument(store, 'c1', true))

    await waitFor(() => expect(result.current.annotations.map((t) => t.id)).toEqual(['t-open']))
    expect(result.current.annotations[0]?.messages[0]?.body).toBe('is this still true?')
  })

  it('republishes when a reply is written into the open document', async () => {
    // What an MCP peer's write looks like once it has merged into the doc
    // this hook holds: a message appended under a thread nobody re-created.
    // The subscription is what has to notice — a one-shot read at load would
    // pass the case above and leave a reply invisible until a reload.
    const store = storeHolding((doc) => {
      writeCommentThread(doc, {
        id: 't-open',
        anchor: { kind: 'text', quote: { exact: 'the second paragraph' }, start: 12, end: 32 },
        status: 'open',
        messages: [{ id: 'm1', body: 'is this still true?' }],
      })
    })

    const { result } = renderHook(() => useMarkdownDocument(store, 'c1', true))
    await waitFor(() => expect(result.current.doc).not.toBeNull())

    const doc = result.current.doc as Loro
    await act(async () => {
      writeThreadMessage(doc, 't-open', { id: 'm2', body: 'no, we changed it' })
    })

    await waitFor(() =>
      expect(result.current.annotations[0]?.messages.map((m) => m.body)).toEqual([
        'is this still true?',
        'no, we changed it',
      ]),
    )
  })

  it('appends a reply to the document, and persists it like any other edit', async () => {
    // The rail offers a reply box on a markdown document only if this
    // works: `handleReply` on the page goes through the spatial session's
    // `onChange`, which for a markdown document is wired to nothing at all.
    // Routing it here instead is what stops the box being a control that
    // silently does nothing.
    const saves: Uint8Array[] = []
    const doc = new LoroDoc()
    writeCommentThread(doc, {
      id: 't-open',
      anchor: { kind: 'text', quote: { exact: 'the second paragraph' }, start: 12, end: 32 },
      status: 'open',
      messages: [{ id: 'm1', body: 'is this still true?' }],
    })
    const snapshot = doc.export({ mode: 'snapshot' })
    const store: LoroStoreLike = {
      async save(_id, bytes) {
        saves.push(bytes)
      },
      createEmptySnapshot() {
        return new Uint8Array()
      },
      async load() {
        return { kind: 'ok', snapshot } as never
      },
    }

    const { result } = renderHook(() => useMarkdownDocument(store, 'c1', true))
    await waitFor(() => expect(result.current.annotations.length).toBe(1))

    await act(async () => {
      result.current.replyToThread('t-open', { id: 'm2', body: 'no, we changed it' })
    })

    await waitFor(() =>
      expect(result.current.annotations[0]?.messages.map((m) => m.body)).toEqual([
        'is this still true?',
        'no, we changed it',
      ]),
    )
    // Written, not merely held: a reply that lives only in memory is lost on
    // the next load, and the debounce it rides is this hook's own.
    await waitFor(() => expect(saves.length).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('answers empty for a document with no conversations, rather than throwing', async () => {
    const store = storeHolding(() => {})
    const { result } = renderHook(() => useMarkdownDocument(store, 'c1', true))

    await waitFor(() => expect(result.current.doc).not.toBeNull())
    expect(result.current.annotations).toEqual([])
  })
})

describe('useMarkdownDocument thread marks', () => {
  const BODY = 'Ship the report on Friday. The draft is not written.'
  const QUOTE = 'report on Friday'
  const AT = { start: BODY.indexOf(QUOTE), end: BODY.indexOf(QUOTE) + QUOTE.length }

  it('marks the passage a new conversation is about', async () => {
    // Writing only the thread leaves the live half empty: every edit from
    // there on is tracked by an offset search rather than by the structure
    // that actually moved the text.
    const store = storeHolding((doc) => {
      writeMarkdownBody(doc, BODY)
    })
    const { result } = renderHook(() => useMarkdownDocument(store, 'c1', true))
    await waitFor(() => expect(result.current.doc).not.toBeNull())

    act(() => {
      result.current.createThread({
        id: 't-new',
        anchor: { kind: 'text', quote: { exact: QUOTE }, ...AT },
        status: 'open',
        messages: [{ id: 'm1', body: 'why Friday?' }],
      })
    })

    await waitFor(() => expect(result.current.threadMarks.get('t-new')).toEqual(AT))
  })

  it('the mark it wrote follows an edit above the passage', async () => {
    const store = storeHolding((doc) => {
      writeMarkdownBody(doc, BODY)
    })
    const { result } = renderHook(() => useMarkdownDocument(store, 'c1', true))
    await waitFor(() => expect(result.current.doc).not.toBeNull())
    act(() => {
      result.current.createThread({
        id: 't-new',
        anchor: { kind: 'text', quote: { exact: QUOTE }, ...AT },
        status: 'open',
        messages: [{ id: 'm1', body: 'why Friday?' }],
      })
    })
    await waitFor(() => expect(result.current.threadMarks.get('t-new')).toEqual(AT))

    const prefix = 'URGENT: '
    act(() => {
      result.current.setBody(`${prefix}${BODY}`)
    })

    await waitFor(() =>
      expect(result.current.threadMarks.get('t-new')).toEqual({
        start: AT.start + prefix.length,
        end: AT.end + prefix.length,
      }),
    )
  })

  it('gives a document that arrived without marks one per quote it can still find', async () => {
    // The import case: marks do not travel through a markdown file, and a
    // thread an MCP peer wrote never had one. The quote is asked once, when
    // the body is first known, and the answer written down.
    const store = storeHolding((doc) => {
      writeMarkdownBody(doc, BODY)
      writeCommentThread(doc, {
        id: 't-imported',
        anchor: { kind: 'text', quote: { exact: QUOTE }, ...AT },
        status: 'open',
        messages: [{ id: 'm1', body: 'why Friday?' }],
      })
    })

    const { result } = renderHook(() => useMarkdownDocument(store, 'c1', true))

    await waitFor(() => expect(result.current.threadMarks.get('t-imported')).toEqual(AT))
  })

  it('leaves a thread whose passage is gone unmarked rather than guessing', async () => {
    const store = storeHolding((doc) => {
      writeMarkdownBody(doc, 'Nothing that sentence said is here any more.')
      writeCommentThread(doc, {
        id: 't-orphan',
        anchor: { kind: 'text', quote: { exact: QUOTE }, ...AT },
        status: 'open',
        messages: [{ id: 'm1', body: 'why Friday?' }],
      })
    })

    const { result } = renderHook(() => useMarkdownDocument(store, 'c1', true))

    await waitFor(() => expect(result.current.annotations.map((t) => t.id)).toEqual(['t-orphan']))
    expect(result.current.threadMarks.has('t-orphan')).toBe(false)
  })
})
