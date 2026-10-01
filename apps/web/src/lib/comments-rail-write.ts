import type { CommentMessage, CommentThread, CommentThreadStatus } from '@kamiazya/whiteboard-model'

/**
 * The keeper-specific write door of the comments rail — the only half a page
 * injects. It lives in `lib/` because both the rail hook above it and the
 * spatial reducer binding below it (`spatial-thread-write.ts`) are defined in
 * terms of it, and a type the lower layer needs cannot be filed in the upper.
 */
export interface CommentsRailWrite {
  readonly createThread: (thread: CommentThread) => void
  readonly replyToThread: (threadId: string, message: CommentMessage) => void
  readonly setThreadStatus: (threadId: string, status: CommentThreadStatus) => void
  /** Rewrites one message; `opening` says whether it is the conversation's first. */
  readonly editMessage: (threadId: string, message: CommentMessage, opening: boolean) => void
}
