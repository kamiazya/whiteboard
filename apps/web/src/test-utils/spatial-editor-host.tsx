import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type CSSProperties, useState } from 'react'
import { SpatialEditor, type SpatialEditorProps } from '../components/spatial-editor/index.js'
import type { EditorTool } from '../lib/editor-tool.js'
import type { EditorCommand } from '../lib/spatial/commands.js'
import type { SpatialEditorHandle } from '../lib/spatial/editor-handle.js'

/**
 * What the editor handed back through `onChange`, which is the value that
 * would have been persisted — so a test asserts on this rather than on React
 * state or the DOM it happens to produce.
 */
interface EditorHostLatest {
  /** The canvas as of the last render. */
  canvas: SpatialCanvas
  /** Every command the editor reported, in order. */
  commands: EditorCommand[]
  /** `commands` by kind, for a test that asserts the sequence and not the payload. */
  kinds: string[]
  /** The imperative handle, or null before the editor mounted. */
  handle: SpatialEditorHandle | null
}

export interface EditorHostOptions {
  initial: SpatialCanvas
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
   * accepted here.
   */
  editorProps?: Omit<SpatialEditorProps, 'canvas' | 'onChange' | 'defaultTool'>
}

const DEFAULT_SIZE = { width: 800, height: 600 }

/**
 * The editor mounted the way every spatial-editor browser test mounts it: a
 * controlled canvas in a fixed-size frame, `onChange` feeding the next canvas
 * back in and recording the command. One definition, so a change to how the
 * editor is mounted in tests is made once.
 */
export function makeEditorHost(options: EditorHostOptions) {
  const {
    initial,
    tool = 'select',
    size = DEFAULT_SIZE,
    frameStyle,
    lockedNodes,
    editorProps,
  } = options
  const latest: EditorHostLatest = { canvas: initial, commands: [], kinds: [], handle: null }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
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
          }}
          theme="light"
          {...(lockedNodes
            ? { lockedNodeIds: new Set(lockedNodes), onToggleNodeLock: () => {} }
            : {})}
          {...editorProps}
        />
      </div>
    )
  }
  return { Host, latest }
}
