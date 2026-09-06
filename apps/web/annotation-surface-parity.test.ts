/**
 * The annotation layer's SURFACE-PARITY matrix: what a reader can do with a
 * conversation, on every surface that shows one, and where each answer is
 * pinned.
 *
 * A coverage ledger (`test-utils/coverage-ledger.ts`) asks whether member
 * N+1 of ONE surface was noticed. This asks the cross-surface question: when
 * a capability lands on one surface, does anything force the others to
 * answer? Measured, nothing did — a rail that could not resolve a
 * conversation shipped beside a card that could, and the only surface a
 * NOTE's thread has is the rail. Nothing was red, because no test had ever
 * been asked to exist.
 *
 * So every cell is a decision, written down: `pinnedBy` names the test that
 * exercises the capability on that surface (a path and a title, both
 * checked below — a renamed test or a deleted file fails here rather than
 * leaving a cell pointing at nothing), or `absent` says why the surface does
 * not have it. "Not yet" is not a reason; a reason names what makes the
 * surface unsuitable, or the decision that is still open and who owns it.
 * `gap` on a pinned cell records the part that is missing WITH its reason.
 *
 * Adding a capability row without every column, or a surface column without
 * every row, is a type error (`satisfies Record<…>`), which is the whole
 * mechanism: the matrix cannot be extended in one dimension only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type Surface =
  /** The spatial editor: card, compose bubble, menus, in-place chrome. */
  | 'canvas'
  /** The comments rail both pages share (`CommentsRailAside` / `CommentsPanel`). */
  | 'rail'
  /** The note's source pane (CodeMirror). */
  | 'markdown-source'
  /** The note's preview (Read / Split). */
  | 'markdown-preview'
  /** canvas-render's laid-out scene: the export and the picture the widget draws. */
  | 'static-scene'
  /** The MCP Apps widget's own controls. */
  | 'widget'
  /** `wb_thread_edit` and what it reaches. */
  | 'mcp'

type Capability =
  | 'compose-on-object'
  | 'compose-on-passage'
  | 'compose-on-document'
  | 'reply'
  | 'resolve-reopen'
  | 'edit-opening-message'
  | 'passage-drawn-in-place'
  | 'set-outline-drawn'
  | 'pin-drawn'
  /** How many messages the conversation holds, said before it is opened. */
  | 'message-count'
  | 'orphan-marked'
  | 'reveal-from-surface'
  | 'touch-reachable'

type Cell =
  | { readonly pinnedBy: `${string}#${string}`; readonly gap?: string }
  | { readonly absent: string }

const PICTURE = 'a picture: it draws, it takes no input'
const WRITES_ONLY =
  'the MCP surface writes; what it draws is wb_scene_render, the static-scene column'
const ONE_WRITE =
  'ADR-0024 decision 6 gives the widget one write, a spot comment; every other verb is the host chat’s, through wb_thread_edit'
const NOT_A_PLACE =
  'a list, not a place: it names the anchor instead (see set-outline-drawn) and says when it is gone'
const NO_OBJECTS = 'a note has no objects; its passages are compose-on-passage'
const READ_MODE =
  'Read mode is for reading: selecting words in the SVG preview is not an editing surface, so the compose entry is the source pane’s catalog (markdown-source)'
const RAIL_ANSWERS =
  'the surface reveals the conversation (reveal-from-surface); the rail is where it is answered'

const PARITY = {
  'compose-on-object': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/comment-create.browser.test.tsx#Comment on this: composes at the node and commits a node-anchored comment',
    },
    rail: {
      absent:
        'the rail composes what a surface hands it; an object is picked on the canvas, not from a list',
    },
    'markdown-source': { absent: NO_OBJECTS },
    'markdown-preview': { absent: NO_OBJECTS },
    'static-scene': { absent: PICTURE },
    widget: {
      pinnedBy:
        'packages/canvas-viewer/src/widget-entry.test.tsx#submitting a comment sends comment.add with the clicked anchor, clears, and refreshes',
      gap: `a spot only — a node, an edge or a selection cannot be named from the widget: ${ONE_WRITE}`,
    },
    mcp: {
      pinnedBy:
        'packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs#edge, node-passage, node-set, region and document threads reach canvas_view',
    },
  },
  'compose-on-passage': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/node-text-comment.browser.test.tsx#a right-click inside the node editor opens the editing catalog, Comment included',
    },
    rail: {
      absent:
        'the passage is picked in the text; the rail shows the compose box the source pane hands it (pinned under markdown-source)',
    },
    'markdown-source': {
      pinnedBy:
        'apps/web/src/pages/BrowserDocumentPage.comments-panel.browser.test.tsx#opens a conversation from the markdown body, end to end',
    },
    'markdown-preview': { absent: READ_MODE },
    'static-scene': { absent: PICTURE },
    widget: { absent: ONE_WRITE },
    mcp: {
      pinnedBy:
        'packages/server-core/src/tools/thread-edit.test.ts#opens a thread on a MARKDOWN document, which the canvas-scoped ops cannot reach',
    },
  },
  'compose-on-document': {
    canvas: {
      absent:
        'the document is on no surface, so the canvas has no place to start it; the rail is the entry, for a canvas and a note alike',
    },
    rail: {
      pinnedBy:
        'apps/web/src/pages/BrowserDocumentPage.comments-panel.browser.test.tsx#starts a conversation about the whole document from the rail, on a note',
    },
    'markdown-source': { absent: 'as for the canvas: the rail is the entry' },
    'markdown-preview': { absent: 'as for the canvas: the rail is the entry' },
    'static-scene': { absent: PICTURE },
    widget: { absent: ONE_WRITE },
    mcp: {
      pinnedBy:
        'packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs#edge, node-passage, node-set, region and document threads reach canvas_view',
    },
  },
  reply: {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/comment-reply.browser.test.tsx#the card commits a reply from its own box',
    },
    rail: {
      pinnedBy:
        'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx#sends a reply from the opened thread, carrying the thread it belongs to',
    },
    'markdown-source': { absent: RAIL_ANSWERS },
    'markdown-preview': { absent: RAIL_ANSWERS },
    'static-scene': { absent: PICTURE },
    widget: { absent: ONE_WRITE },
    mcp: {
      pinnedBy:
        'packages/server-core/src/tools/thread-edit.test.ts#appends a message to an existing thread without disturbing the first',
    },
  },
  'resolve-reopen': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/comment-resolve.browser.test.tsx#"Resolve" on a comment writes set-comment-resolved and the comment leaves the canvas',
    },
    rail: {
      pinnedBy:
        'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx#closes and reopens a conversation from the rail, which is where a note can do it at all',
    },
    'markdown-source': { absent: RAIL_ANSWERS },
    'markdown-preview': { absent: RAIL_ANSWERS },
    'static-scene': { absent: PICTURE },
    widget: { absent: ONE_WRITE },
    mcp: {
      pinnedBy:
        'packages/server-core/src/tools/thread-edit.test.ts#resolves and reopens, and offers no way to remove — the ADR-0025 symmetry',
    },
  },
  'edit-opening-message': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/comment-edit.browser.test.tsx#the card Edit opens the compose bubble pre-filled; Ctrl+Enter commits set-comment-text',
    },
    rail: {
      pinnedBy:
        'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx#rewrites the opening message from the rail, and an unchanged or emptied draft writes nothing',
    },
    'markdown-source': { absent: RAIL_ANSWERS },
    'markdown-preview': { absent: RAIL_ANSWERS },
    'static-scene': { absent: PICTURE },
    widget: { absent: ONE_WRITE },
    mcp: {
      absent:
        'wb_thread_edit deliberately carries add / reply / resolve and no removal (ADR-0026 decision 6); whether an agent may REWRITE a message is an open contract decision for the ADR, recorded here rather than assumed either way',
    },
  },
  'passage-drawn-in-place': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/node-text-comment.browser.test.tsx#editing a node draws its commented passage highlighted, with no gutter shifting the text',
    },
    rail: { absent: NOT_A_PLACE },
    'markdown-source': {
      pinnedBy:
        'apps/web/src/components/markdown-editor/annotation-projection.browser.test.tsx#marks the quoted passage and puts a marker in the gutter',
    },
    'markdown-preview': {
      pinnedBy:
        'apps/web/src/components/markdown-editor/preview-comment-markers.browser.test.tsx#marks each conversation beside its block in Read mode, lower passages lower',
      gap: 'a marker beside the block, not a wash over the words: the preview SVG is laid out by canvas-render from the body alone, and drawing a note’s passages there means composeMarkdownScene taking threads — the same step the canvas took, undecided for a note (ADR-0026 1b says an export carries content)',
    },
    'static-scene': {
      pinnedBy:
        'packages/canvas-render/src/layout/comments.test.ts#highlights exactly the quoted words, measured with the run’s own font, behind the run',
    },
    widget: {
      pinnedBy:
        'packages/canvas-viewer/src/CanvasViewer.test.tsx#outlines a node set from `threads`, which the flat comments in the canvas cannot carry',
    },
    mcp: { absent: WRITES_ONLY },
  },
  'set-outline-drawn': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/multi-select.browser.test.tsx#Comment on selection opens a thread about every member, outlined as one box',
    },
    rail: {
      pinnedBy:
        'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx#says what a thread is about when nothing on a surface can: the document, a node set',
    },
    'markdown-source': { absent: 'a canvas anchor is about a surface a note has not got' },
    'markdown-preview': { absent: 'a canvas anchor is about a surface a note has not got' },
    'static-scene': {
      pinnedBy:
        'packages/canvas-render/src/layout/comments.test.ts#outlines the box the live nodes occupy and stands the pin at its top-right corner',
    },
    widget: {
      pinnedBy:
        'packages/canvas-viewer/src/CanvasViewer.test.tsx#outlines a node set from `threads`, which the flat comments in the canvas cannot carry',
    },
    mcp: { absent: WRITES_ONLY },
  },
  /**
   * The count is what makes a marker worth pressing: without it a reader
   * decides whether to open a conversation by opening it. Four surfaces
   * carry it now and the canvas was the last to get one, which is exactly
   * the drift this matrix exists to make visible.
   */
  'message-count': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/comment-pin-count.browser.test.tsx#draws the message count on a busy conversation pin, and none on a lone remark',
    },
    rail: {
      pinnedBy:
        'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx#dates a conversation by its LAST message, not the one that started it',
    },
    'markdown-source': {
      pinnedBy:
        'apps/web/src/components/markdown-editor/annotation-projection.browser.test.tsx#carries the conversation message count, so its weight is readable before opening',
    },
    'markdown-preview': {
      pinnedBy:
        'apps/web/src/components/markdown-editor/preview-comment-markers.browser.test.tsx#says how many messages a conversation holds, the way its gutter marker does',
    },
    'static-scene': {
      pinnedBy:
        'packages/canvas-render/src/layout/comments.test.ts#draws how many messages the conversation holds, once there is more than one',
    },
    widget: {
      absent:
        'the widget draws canvas-render’s scene, so it has the count the static-scene column pins rather than a control of its own',
    },
    mcp: { absent: WRITES_ONLY },
  },
  'pin-drawn': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/edge-comment.browser.test.tsx#an edge’s menu opens a comment about the edge, pinned on its line',
    },
    rail: { absent: NOT_A_PLACE },
    'markdown-source': { absent: 'a canvas anchor is about a surface a note has not got' },
    'markdown-preview': { absent: 'a canvas anchor is about a surface a note has not got' },
    'static-scene': {
      pinnedBy:
        'packages/canvas-render/src/layout/comments.test.ts#draws a pin centered on the anchor and a bubble holding the text, after all content',
    },
    widget: {
      pinnedBy:
        'packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs#wb_canvas_edit → comment.add reaches canvas_view, comment.resolve marks it',
    },
    mcp: { absent: WRITES_ONLY },
  },
  'orphan-marked': {
    canvas: {
      pinnedBy:
        'packages/canvas-render/src/layout/comments.test.ts#follows the target node when it resolves, and falls back to the anchor when it is gone',
    },
    rail: {
      pinnedBy:
        'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx#lists an orphaned thread rather than hiding it, and marks it as having no place',
    },
    'markdown-source': {
      pinnedBy:
        'apps/web/src/components/markdown-editor/annotation-projection.browser.test.tsx#leaves the body unmarked when the passage is gone',
    },
    'markdown-preview': {
      pinnedBy:
        'apps/web/src/components/markdown-editor/preview-comment-markers.browser.test.tsx#an orphaned conversation gets no preview marker',
    },
    'static-scene': {
      pinnedBy:
        'packages/canvas-render/src/layout/comments.test.ts#falls back to the stored rect once every node is gone, and hides a resolved one unless asked',
    },
    widget: {
      absent: 'draws the static scene; the fallback point and rect are the static-scene column’s',
    },
    mcp: {
      absent:
        'orphaned is a reader’s judgement against the document as it stands; the tool stores anchors and never drops one (ADR-0026 decision 4)',
    },
  },
  'reveal-from-surface': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/node-text-comment.browser.test.tsx#the quoted words are highlighted on the canvas itself, and a press on them opens the conversation',
    },
    rail: {
      pinnedBy:
        'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx#opens the conversation the host asks for, widening a filter that would have hidden it',
    },
    'markdown-source': {
      pinnedBy:
        'apps/web/src/pages/BrowserDocumentPage.comments-panel.browser.test.tsx#reaches a note thread from the body: its gutter marker opens the rail on that conversation',
    },
    'markdown-preview': {
      pinnedBy:
        'apps/web/src/components/markdown-editor/preview-comment-markers.browser.test.tsx#a press on a preview marker opens that conversation',
    },
    'static-scene': { absent: PICTURE },
    widget: {
      absent: `the widget shows the picture and offers one write; opening a conversation is the host chat’s, through the threads canvas_view hands it: ${ONE_WRITE}`,
    },
    mcp: { absent: WRITES_ONLY },
  },
  'touch-reachable': {
    canvas: {
      pinnedBy:
        'apps/web/src/components/spatial-editor/comment-card-touch.browser.test.tsx#a finger opens the card on its FIRST tap, the release landing on the node it pressed',
    },
    rail: {
      pinnedBy:
        'apps/web/src/components/annotations/CommentsRailChrome.browser.test.tsx#is a sheet over the editor on a phone, and can be closed from it',
    },
    'markdown-source': {
      absent:
        'untested on touch: the ⋯ button that opens the catalog is a native control and the long-press catalog is the same menu, so no touch-only path exists to pin — a device dogfood is the missing instrument',
    },
    'markdown-preview': {
      absent:
        'untested on touch: the preview marker is a native button; a device dogfood is the missing instrument',
    },
    'static-scene': { absent: PICTURE },
    widget: { absent: 'the widget’s controls are native form elements in the host’s frame' },
    mcp: {
      absent: 'a tool call has no pointer: touch reach is a property of the surfaces that draw',
    },
  },
} satisfies Record<Capability, Record<Surface, Cell>>

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

describe('the annotation layer’s surface-parity matrix', () => {
  const cells = Object.entries(PARITY).flatMap(([capability, row]) =>
    Object.entries(row).map(([surface, cell]) => ({ capability, surface, cell: cell as Cell })),
  )

  it('every pinned cell names a test file that exists and a title it holds', () => {
    const broken: string[] = []
    for (const { capability, surface, cell } of cells) {
      if (!('pinnedBy' in cell)) continue
      const hash = cell.pinnedBy.indexOf('#')
      const file = cell.pinnedBy.slice(0, hash)
      const title = cell.pinnedBy.slice(hash + 1)
      const path = `${REPO_ROOT}${file}`
      if (!existsSync(path)) {
        broken.push(`${capability} × ${surface}: ${file} does not exist`)
        continue
      }
      if (!readFileSync(path, 'utf8').includes(title)) {
        broken.push(`${capability} × ${surface}: ${file} holds no test titled "${title}"`)
      }
    }
    expect(
      broken,
      'a cell points at a test that is not there — retarget it or say why the surface lost the capability',
    ).toEqual([])
  })

  it('every absent cell, and every gap, carries a reason rather than a deferral', () => {
    const deferrals = /^\s*(todo|tbd|later|not yet|wip|pending)\b/i
    const weak: string[] = []
    for (const { capability, surface, cell } of cells) {
      const reason = 'absent' in cell ? cell.absent : cell.gap
      if (reason === undefined) continue
      if (reason.trim().length < 24 || deferrals.test(reason)) {
        weak.push(`${capability} × ${surface}: "${reason}"`)
      }
    }
    expect(
      weak,
      'a reason names what makes the surface unsuitable or the open decision — a deferral is the omission with a word in front of it',
    ).toEqual([])
  })

  it('every capability is pinned on at least one surface — a row of nothing but reasons is a capability nobody has', () => {
    const unpinned = Object.entries(PARITY)
      .filter(([, row]) => !Object.values(row).some((cell) => 'pinnedBy' in cell))
      .map(([capability]) => capability)
    expect(unpinned).toEqual([])
  })
})
