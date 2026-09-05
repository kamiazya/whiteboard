/**
 * The comments/annotation rail's screen state and write handlers, shared by
 * the browser and daemon document pages (previously duplicated between them
 * near-verbatim — the second extraction after `useVersionSaveFlow`, on the
 * same rationale: state a hook owns cannot drift between the pages, and a
 * reset a hook owns cannot be forgotten by the next page).
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
  CommentMessage,
  CommentThread,
  DocumentKind,
  SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { anchorResolverFor } from '../lib/anchor-resolver.js'
import { markdownAnchorResolver } from '../lib/text-anchor.js'

/** The keeper-specific write door — the only injected half. */
export interface CommentsRailWrite {
  readonly createThread: (thread: CommentThread) => void
  readonly replyToThread: (threadId: string, message: CommentMessage) => void
}

export interface CommentsRail {
  /** Whether the rail is open. Per-user view state, written nowhere. */
  readonly open: boolean
  readonly toggle: () => void
  /** The conversation the reader is on, shared by rail and body projection. */
  readonly selectedThreadId: string | null
  readonly selectThread: (threadId: string | null) => void
  /** A passage waiting for its first message; null when nothing is composing. */
  readonly composeAnchor: AnnotationAnchor | null
  /** Opens the rail on one conversation — what a gutter marker press means. */
  readonly revealThread: (threadId: string) => void
  /** Opens the rail with the compose box on a passage. */
  readonly composeThread: (anchor: AnnotationAnchor) => void
  readonly cancelCompose: () => void
  readonly openThreadCount: number
  /** ADR-0026 decision 4 — whether an anchor still finds its place. */
  readonly resolveAnchor: ((thread: CommentThread) => 'placed' | 'orphaned') | undefined
  readonly createThread: (anchor: AnnotationAnchor, body: string) => void
  readonly reply: (threadId: string, body: string) => void
}

export function useCommentsRail(args: {
  /**
   * The page's document identity. The hook owns the scope reset: a selected
   * thread id and a compose anchor both belong to the DOCUMENT (left
   * standing across a switch they would scroll the arrived body to a
   * passage the departed document quoted, or open a conversation about a
   * sentence nobody there wrote). `open` is deliberately NOT reset — what a
   * switch changes is the list, not whether the reader wanted to be looking
   * at one.
   */
  scopeKey: unknown
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
  const { scopeKey, threads, documentKind, markdownBody, canvas, threadMarks } = args
  const [open, setOpen] = useState(false)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [composeAnchor, setComposeAnchor] = useState<AnnotationAnchor | null>(null)

  // The door customises WHERE a write goes, not WHICH write this is — held
  // in a ref so pages can pass an inline object without churning callbacks.
  const writeRef = useRef(args.write)
  writeRef.current = args.write

  // SCOPE RESET — owned here; see the scopeKey doc comment above.
  useEffect(() => {
    setSelectedThreadId(null)
    setComposeAnchor(null)
  }, [scopeKey])

  const toggle = useCallback(() => setOpen((wasOpen) => !wasOpen), [])
  const selectThread = useCallback((threadId: string | null) => {
    setSelectedThreadId(threadId)
  }, [])
  const revealThread = useCallback((threadId: string) => {
    setOpen(true)
    setSelectedThreadId(threadId)
  }, [])
  const composeThread = useCallback((anchor: AnnotationAnchor) => {
    setOpen(true)
    // Nothing else expanded: the reader asked for a new conversation, and an
    // already-open one beside the draft box is two reply fields on screen.
    setSelectedThreadId(null)
    setComposeAnchor(anchor)
  }, [])
  const cancelCompose = useCallback(() => setComposeAnchor(null), [])

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
  const resolveAnchor = useMemo(() => {
    if (documentKind === 'markdown') return markdownAnchorResolver(markdownBody, threadMarks)
    if (documentKind !== 'spatial' || canvas === null) return undefined
    // Every reference a canvas anchor can carry — a node, an edge, a node
    // set, a passage of a node's text — judged by one reader.
    return anchorResolverFor({ kind: 'spatial', canvas })
  }, [documentKind, canvas, markdownBody, threadMarks])

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

  return {
    open,
    toggle,
    selectedThreadId,
    selectThread,
    composeAnchor,
    revealThread,
    composeThread,
    cancelCompose,
    openThreadCount,
    resolveAnchor,
    createThread,
    reply,
  }
}
