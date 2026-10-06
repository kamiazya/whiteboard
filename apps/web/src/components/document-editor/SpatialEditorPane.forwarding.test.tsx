import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpatialEditorProps } from '../spatial-editor/index.js'
import { SpatialEditorPane, type SpatialEditorPassedThrough } from './SpatialEditorPane.js'

const seen = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  overlay: null as Record<string, unknown> | null,
}))

vi.mock('./NodeTextEditorOverlay.js', () => ({
  NodeTextEditorOverlay: (props: Record<string, unknown>) => {
    seen.overlay = props
    return null
  },
}))

vi.mock('../spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spatial-editor/index.js')>()
  return {
    ...actual,
    SpatialEditor: (props: Record<string, unknown>) => {
      seen.props = props
      return null
    },
  }
})

/**
 * One value per key the pane picks from the editor's props. `Required<>`
 * makes a key added to the Pick without a row here a compile error, so the
 * fixture cannot fall behind the contract it checks.
 */
const passedThrough: Required<SpatialEditorPassedThrough> = {
  canvas: { nodes: [], edges: [] },
  onChange: () => {},
  externalVersion: 7,
  theme: 'dark',
  fileRefOptions: [],
  missingFileRef: () => false,
  lockedNodeIds: new Set(['n1']),
  lockedEdgeIds: new Set(['e1']),
  onToggleNodeLock: () => {},
  onToggleEdgeLock: () => {},
  agentTouchedNodeIds: new Set(['n2']),
  agentTouchedEdgeIds: new Set(['e2']),
  agentTouchedLineIds: new Set(['l2']),
  agentTouchedCommentIds: new Set(['c2']),
  threads: [],
  proposals: [],
  tagLibrary: { tags: {} },
  tagSuggestions: ['planning'],
  facetRegistry: {} as NonNullable<SpatialEditorProps['facetRegistry']>,
}

afterEach(() => {
  seen.props = null
  seen.overlay = null
})

describe('SpatialEditorPane', () => {
  it('forwards every prop it picks from the editor to the editor', () => {
    renderPane(null)
    const props = seen.props
    expect(props).not.toBeNull()
    const dropped = Object.entries(passedThrough)
      .filter(([key, value]) => props?.[key] !== value)
      .map(([key]) => key)
    expect(dropped, 'picked by the pane but never handed to the editor').toEqual([])
  })

  it(`hands the "open in editor" overlay the tag library the board is drawn with`, () => {
    // A text node's `![[board]]` previews there, and is coloured as on the canvas.
    renderPane({ id: 'n1', text: 'body' })
    expect(seen.overlay?.tagLibrary).toBe(passedThrough.tagLibrary)
  })
})

function renderPane(editing: { id: string; text: string } | null) {
  render(
    <SpatialEditorPane
      editorKey="doc"
      canvasLoaded
      fileSeams={{
        references: { entries: [], aliases: [], titles: [], extras: [] },
        onAddImage: () => Promise.reject(new Error('unused')),
        isImageFileRef: () => false,
      }}
      nodeInEditor={{
        open: () => {},
        editing,
        commit: () => {},
        close: () => {},
        draft: () => {},
        draftBodies: [],
      }}
      onOpenDocument={() => {}}
      history={{ onUndo: () => {}, onRedo: () => {}, canUndo: false, canRedo: false }}
      overlayTitle="Board"
      linkTargets={[]}
      className="pane"
      {...passedThrough}
    />,
  )
}
