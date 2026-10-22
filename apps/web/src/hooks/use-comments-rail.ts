/**
 * The comments/annotation rail's screen state and write handlers, shared by
 * the browser and daemon document pages. State a hook owns cannot drift
 * between the pages, and a reset a hook owns cannot be forgotten by one of
 * them.
 *
 * What stays keeper-specific is only the WRITE DOOR: the daemon page routes
 * both writes through `onChange` (one undo step, rides the annotation
 * channel); the browser page branches — a markdown document is given no
 * BrowserBackend, so its writes go to the host holding it instead. The hook
 * builds the thread/message (minting an id and stamping a time are its
 * concern, not the door's) and hands the finished value over.
 */

import type { PassageRange } from '@kamiazya/whiteboard-loro-adapter'
import type {
  AnnotationAnchor,
  CommentThread,
  DocumentKind,
  SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { anchorChipLabel } from '../lib/anchor-chip-label.js'
import { anchorResolverFor } from '../lib/anchor-resolver.js'
import { captureFocusInto } from '../lib/capture-focus.js'
import type { CommentsRailWrite } from '../lib/comments-rail-write.js'
import { type QuoteMemory, quoteMemoryFor } from '../lib/quote-occurrences.js'
import { markdownAnchorResolver } from '../lib/text-anchor.js'

export interface CommentsRail {
  /** Whether the rail is open — the page's inspector slot showing it. */
  readonly open: boolean
  readonly toggle: () => void
  /** The conversation the reader is on, shared by rail and body projection. */
  readonly selectedThreadId: string | null
  readonly selectThread: (threadId: string | null) => void
  /** A passage waiting for its first message; null when nothing is composing. */
  readonly composeAnchor: AnnotationAnchor | null
  /**
   * The conversation the reader just asked to be taken to, as a fresh object
   * per request so choosing the same row twice is two requests. A surface
   * that can show an anchor (the spatial canvas) answers it by moving there.
   */
  readonly revealRequest: { readonly threadId: string } | null
  /** A few words naming what an anchor is about, for a list row's chip. */
  readonly anchorLabelOf: (anchor: AnnotationAnchor) => string
  /** Opens the rail on one conversation — what a gutter marker press means. */
  readonly revealThread: (threadId: string) => void
  /** Opens the rail with the compose box on a passage. */
  readonly composeThread: (anchor: AnnotationAnchor) => void
  readonly cancelCompose: () => void
  /**
   * Hands focus back to the surface the rail was opened from — what Escape
   * in the rail means. See `captureFocusInto` for why the two entries that
   * OPEN it are the ones that remember.
   */
  readonly returnFocus: () => void
  readonly openThreadCount: number
  /** ADR-0026 decision 4 — whether an anchor still finds its place. */
  readonly resolveAnchor: ((thread: CommentThread) => 'placed' | 'orphaned') | undefined
  readonly createThread: (anchor: AnnotationAnchor, body: string) => void
  readonly reply: (threadId: string, body: string) => void
  /** Closes or reopens a conversation — the card's Resolve, reachable from the rail too. */
  readonly resolve: (threadId: string, resolved: boolean) => void
  /** Rewrites a message's body, stamping `editedAt`; a message the rail does not hold is ignored. */
  readonly editMessage: (threadId: string, messageId: string, body: string) => void
}

/**
 * The rail's judge of a markdown document's text anchors. Where each quote
 * was found in the last body is carried to the next, so a keystroke does not
 * cost every row a search of the whole body — a cache, not state: nothing
 * renders from it, and losing it costs only the search.
 */
function useMarkdownAnchorResolver(
  body: string | null,
  marks: ReadonlyMap<string, PassageRange> | undefined,
): ReturnType<typeof markdownAnchorResolver> {
  const memory = useRef<QuoteMemory | null>(null)
  if (body !== null) memory.current = quoteMemoryFor(memory.current, body)
  const quotes = body === null ? undefined : (memory.current ?? undefined)
  return useMemo(() => markdownAnchorResolver(body, marks, quotes), [body, marks, quotes])
}

export function useCommentsRail(args: {
  /**
   * The page's document identity. The hook owns the scope reset: a selected
   * thread id and a compose anchor both belong to the DOCUMENT (left
   * standing across a switch they would scroll the arrived body to a
   * passage the departed document quoted, or open a conversation about a
   * sentence nobody there wrote). Whether the rail is OPEN is the page's
   * inspector slot and is not reset either — what a switch changes is the
   * list, not whether the reader wanted to be looking at one.
   */
  scopeKey: unknown
  /**
   * Whether the rail is open, and how to change that. Owned by the PAGE
   * rather than here because the rail shares one inspector slot with the
   * history column: opening either closes the other, and a slot that lives
   * in two hooks cannot be exclusive. Per-user view state, written nowhere.
   */
  open: boolean
  onOpenChange: (open: boolean) => void
  threads: readonly CommentThread[]
  documentKind: DocumentKind | null
  /** The markdown body, for judging text anchors; null off a markdown doc. */
  markdownBody: string | null
  /**
   * Where the CRDT still holds each passage, by thread id — the live half of
   * a text anchor, absent for a keeper with none to give. Only a markdown
   * document has a body for a mark to live in, so a spatial page passes
   * nothing and the resolver falls back to the quote for everything.
   */
  threadMarks?: ReadonlyMap<string, PassageRange>
  /** The spatial canvas, for judging node anchors; null off a spatial doc. */
  canvas: SpatialCanvas | null
  write: CommentsRailWrite
}): CommentsRail {
  const { scopeKey, open, onOpenChange, threads, documentKind, markdownBody, canvas, threadMarks } =
    args
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [composeAnchor, setComposeAnchor] = useState<AnnotationAnchor | null>(null)
  const [revealRequest, setRevealRequest] = useState<{ readonly threadId: string } | null>(null)

  // The door customises WHERE a write goes, not WHICH write this is — held
  // in a ref so pages can pass an inline object without churning callbacks.
  const writeRef = useRef(args.write)
  writeRef.current = args.write

  // SCOPE RESET — owned here; see the scopeKey doc comment above.
  useEffect(() => {
    setSelectedThreadId(null)
    setComposeAnchor(null)
    setRevealRequest(null)
  }, [scopeKey])

  const toggle = useCallback(() => onOpenChange(!open), [open, onOpenChange])
  const selectThread = useCallback((threadId: string | null) => {
    setSelectedThreadId(threadId)
    setRevealRequest(threadId === null ? null : { threadId })
  }, [])
  // Deliberately not written by `selectThread`: choosing another
  // conversation from inside the rail is not an entry, and re-capturing
  // there would make the way out a row of the list the reader is standing
  // in.
  const returnTargetRef = useRef<HTMLElement | null>(null)
  const returnFocus = useCallback(() => {
    // Two cases need no guard of their own, which was measured rather than
    // assumed after guards for both proved impossible to fail: `focus()` is
    // a no-op on `document.body` (what `activeElement` answers when nothing
    // holds focus) and on a node the surface has since unmounted, because
    // neither is a focusable area. The reader stays where they are, which is
    // what either guard was there to arrange.
    returnTargetRef.current?.focus()
  }, [])
  const revealThread = useCallback(
    (threadId: string) => {
      captureFocusInto(returnTargetRef)
      onOpenChange(true)
      setSelectedThreadId(threadId)
      setRevealRequest({ threadId })
    },
    [onOpenChange],
  )
  const composeThread = useCallback(
    (anchor: AnnotationAnchor) => {
      captureFocusInto(returnTargetRef)
      onOpenChange(true)
      // Nothing else expanded: the reader asked for a new conversation, and an
      // already-open one beside the draft box is two reply fields on screen.
      setSelectedThreadId(null)
      setComposeAnchor(anchor)
    },
    [onOpenChange],
  )
  const cancelCompose = useCallback(() => setComposeAnchor(null), [])

  const anchorLabelOf = useCallback(
    (anchor: AnnotationAnchor) => anchorChipLabel(anchor, canvas),
    [canvas],
  )

  const openThreadCount = useMemo(
    () => threads.filter((thread) => thread.status === 'open').length,
    [threads],
  )

  /**
   * Whether a thread's anchor still finds its place (ADR-0026 decision 4:
   * deleting the subject of a conversation must not delete the conversation).
   *
   * Spatial documents judge only an anchor that NAMES a node; a markdown
   * document judges a text anchor's passage against the body. Any other kind
   * answers `undefined` — "this host cannot tell", which the panel renders
   * as neither placed nor orphaned.
   */
  const markdownResolver = useMarkdownAnchorResolver(markdownBody, threadMarks)
  const resolveAnchor = useMemo(() => {
    if (documentKind === 'markdown') return markdownResolver
    if (documentKind !== 'spatial' || canvas === null) return undefined
    // Every reference a canvas anchor can carry — a node, an edge, a node
    // set, a passage of a node's text — judged by one reader.
    return anchorResolverFor({ kind: 'spatial', canvas })
  }, [documentKind, canvas, markdownResolver])

  /**
   * Opens the conversation the compose box collected, whole. Built HERE
   * rather than in the rail or the door: minting an id and stamping a time
   * are this hook's concern, and the post-create moves (clear the compose
   * box, land the reader inside the conversation just opened) must not be
   * repeatable-by-omission at each door.
   */
  const createThread = useCallback((anchor: AnnotationAnchor, body: string) => {
    const thread: CommentThread = {
      id: crypto.randomUUID(),
      anchor,
      status: 'open',
      messages: [
        {
          id: crypto.randomUUID(),
          body,
          // No author: this app has no accounts, so there is no name to
          // write that would not be invented. A message an MCP peer wrote
          // carries the one its caller supplied.
          createdAt: new Date().toISOString(),
        },
      ],
    }
    writeRef.current.createThread(thread)
    setComposeAnchor(null)
    setSelectedThreadId(thread.id)
  }, [])

  /** Appends the reader's reply to a conversation, through the same door. */
  const reply = useCallback((threadId: string, body: string) => {
    writeRef.current.replyToThread(threadId, {
      id: crypto.randomUUID(),
      body,
      createdAt: new Date().toISOString(),
    })
  }, [])

  const resolve = useCallback((threadId: string, resolved: boolean) => {
    writeRef.current.setThreadStatus(threadId, resolved ? 'resolved' : 'open')
  }, [])

  // The message is rebuilt from the one the rail holds rather than from the
  // body alone: the write upserts by id and would otherwise drop the author
  // and the original stamp.
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const editMessage = useCallback((threadId: string, messageId: string, body: string) => {
    const thread = threadsRef.current.find((entry) => entry.id === threadId)
    const index = thread?.messages.findIndex((entry) => entry.id === messageId) ?? -1
    const message = thread?.messages[index]
    if (thread === undefined || message === undefined) return
    writeRef.current.editMessage(
      threadId,
      { ...message, body, editedAt: new Date().toISOString() },
      index === 0,
    )
  }, [])

  return {
    open,
    toggle,
    selectedThreadId,
    selectThread,
    revealRequest,
    anchorLabelOf,
    composeAnchor,
    revealThread,
    composeThread,
    cancelCompose,
    returnFocus,
    openThreadCount,
    resolveAnchor,
    createThread,
    reply,
    resolve,
    editMessage,
  }
}
