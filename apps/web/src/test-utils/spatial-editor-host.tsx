import {
  type CanvasComment,
  type CommentThread,
  canvasCommentsOf,
  type SpatialCanvas,
  threadFromCanvasComment,
} from '@kamiazya/whiteboard-model'
import { type CSSProperties, useState } from 'react'
import { SpatialEditor, type SpatialEditorProps } from '../components/spatial-editor/index.js'
import type { EditorTool } from '../lib/editor-tool.js'
import type { EditorCommand } from '../lib/spatial/commands.js'
import type { SpatialEditorHandle } from '../lib/spatial/editor-handle.js'
import { threadsAfterCommand } from '../lib/spatial/thread-commands.js'

/**
 * A board written with its comments inline, the shorthand a test reads most
 * easily. The host hands them to the editor the way a page really does: as
 * the threads they are, beside the canvas, which never carries them.
 */
export type CommentBoard = SpatialCanvas & { readonly comments?: readonly CanvasComment[] }

/** A board's canvas and the threads its inline comments stand for. */
export function splitBoard(board: CommentBoard): {
  readonly canvas: SpatialCanvas
  readonly threads: readonly CommentThread[]
} {
  const { comments = [], ...canvas } = board
  return { canvas, threads: comments.map(threadFromCanvasComment) }
}

/**
 * What the editor handed back through `onChange`, which is the value that
 * would have been persisted — so a test asserts on this rather than on React
 * state or the DOM it happens to produce.
 */
interface EditorHostLatest {
  /** The canvas as of the last render. */
  canvas: SpatialCanvas
  /** The conversations as of the last render — what a page's sync session would publish. */
  threads: readonly CommentThread[]
  /** `threads` as the pins the canvas draws: the render-time view. */
  readonly comments: readonly CanvasComment[]
  /** Every command the editor reported, in order. */
  commands: EditorCommand[]
  /** `commands` by kind, for a test that asserts the sequence and not the payload. */
  kinds: string[]
  /** The imperative handle, or null before the editor mounted. */
  handle: SpatialEditorHandle | null
}

export interface EditorHostOptions {
  initial: CommentBoard
  /**
   * `'select'` unless said otherwise. `null` passes no `defaultTool`, which
   * leaves the choice to the editor — the way to test its own default.
   */
  tool?: EditorTool | null
  /** The frame the editor fills; a layout-dependent case sets it. */
  size?: { width: number; height: number }
  /** Style merged over the frame, for a case that needs the page to scroll or to position. */
  frameStyle?: CSSProperties
  /**
   * Node ids the editor treats as locked. Passing any list, even an empty
   * one, also turns the lock affordance on — that is part of what a lock
   * case exercises.
   */
  lockedNodes?: readonly string[]
  /**
   * Anything else the editor takes (threads, locks, references, ...). The
   * host owns `canvas`, `onChange` and `defaultTool`, so those are not
   * accepted here. `theme` is `'light'` unless a case says otherwise.
   */
  editorProps?: Omit<SpatialEditorProps, 'canvas' | 'onChange' | 'defaultTool' | 'theme'> &
    Partial<Pick<SpatialEditorProps, 'theme'>>
}

const DEFAULT_SIZE = { width: 800, height: 600 }

/**
 * The editor mounted the way every spatial-editor browser test mounts it: a
 * controlled canvas in a fixed-size frame, `onChange` feeding the next canvas
 * back in and recording the command. One definition, so a change to how the
 * editor is mounted in tests is made once.
 */
/** Threads a case hands over explicitly win by id over its inline comments. */
function seededThreads(
  inline: readonly CommentThread[],
  given: readonly CommentThread[],
): CommentThread[] {
  return [...given, ...inline.filter((thread) => !given.some((held) => held.id === thread.id))]
}

function freshLatest(canvas: SpatialCanvas, threads: readonly CommentThread[]): EditorHostLatest {
  return {
    canvas,
    threads,
    get comments() {
      return canvasCommentsOf(this.threads, this.canvas.nodes)
    },
    commands: [],
    kinds: [],
    handle: null,
  }
}

export function makeEditorHost(options: EditorHostOptions) {
  const {
    initial,
    tool = 'select',
    size = DEFAULT_SIZE,
    frameStyle,
    lockedNodes,
    editorProps,
  } = options
  const seeded = splitBoard(initial)
  const initialThreads = seededThreads(seeded.threads, editorProps?.threads ?? [])
  const latest = freshLatest(seeded.canvas, initialThreads)
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(seeded.canvas)
    const [threads, setThreads] = useState<readonly CommentThread[]>(initialThreads)
    latest.canvas = canvas
    latest.threads = threads
    return (
      <div style={{ ...size, ...frameStyle }}>
        <SpatialEditor
          ref={(handle) => {
            latest.handle = handle
          }}
          {...(tool === null ? {} : { defaultTool: tool })}
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command)
            latest.kinds.push(command.kind)
            setCanvas(next)
            // What a page's sync session publishes for the same command.
            setThreads((held) => threadsAfterCommand(held, command))
          }}
          theme="light"
          {...(lockedNodes
            ? { lockedNodeIds: new Set(lockedNodes), onToggleNodeLock: () => {} }
            : {})}
          {...editorProps}
          threads={threads}
        />
      </div>
    )
  }
  return { Host, latest }
}

/**
 * The comments a command list opened, as the pins they draw: each
 * `create-thread`'s render-time view, against the nodes given (a passage of a
 * node's text stands at that node's corner).
 */
export function createdComments(
  commands: readonly EditorCommand[],
  nodes: SpatialCanvas['nodes'] = [],
): CanvasComment[] {
  return canvasCommentsOf(
    commands.flatMap((command) => (command.kind === 'create-thread' ? [command.thread] : [])),
    nodes,
  )
}
