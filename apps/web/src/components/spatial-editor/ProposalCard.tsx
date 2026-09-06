/**
 * One proposal, opened in place on the document it is about (ADR-0029
 * decision 1: "a bubble offering Adopt and Dismiss").
 *
 * The bubble the renderer draws is a COUNT — how many changes are open and
 * whether any of them needs a look. This card is the proposal itself: what
 * each change would do, and the two verbs that decide it.
 *
 * Whole-proposal only, which is decision 4's default and, for now, all of
 * it: a batch arrived together because it was meant to be judged together
 * (decision 8), and per-change expansion is a later increment rather than a
 * missing half of this one (user decision, 2026-09-06).
 *
 * Positioned in SCREEN coordinates beside the minimap, and wearing the
 * bubble's own chrome, for the reasons CommentThreadCard states at length:
 * the transform layer is a stacking context below the ambient chrome, and a
 * card's controls are tap targets whose size should not follow the zoom.
 */
import {
  BODY_FONT_SIZE_PX,
  BODY_LINE_HEIGHT_PX,
  COMMENT_BUBBLE_PADDING_PX,
  COMMENT_BUBBLE_RADIUS_PX,
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  SPATIAL_THEME_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-render'
import type {
  Proposal,
  ProposedChange,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { canvasChangeConflicts } from '@kamiazya/whiteboard-model'
import { X } from 'lucide-react'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { editorTextFill } from '../../lib/spatial/editor-appearance.js'
import type { Box } from '../../lib/spatial/geometry.js'
import type { ResolvedTheme } from '../../lib/theme.js'

/** Screen px kept between the card and the root's edge once slid inside. */
const CARD_EDGE_MARGIN_PX = 8

/** How much of a node's own words identify it in a change's line. */
const NAME_MAX_CHARS = 24

export interface ProposalCardProps {
  readonly proposal: Proposal
  /** The board as it stands, so a change can be named and checked against it. */
  readonly canvas: SpatialCanvas
  /** Where the bubble is drawn, in SCREEN coordinates (root-relative). */
  readonly box: Box
  readonly theme: ResolvedTheme
  readonly onDecide: (decision: 'adopted' | 'dismissed') => void
  readonly onClose: () => void
}

export function ProposalCard({
  proposal,
  canvas,
  box,
  theme,
  onDecide,
  onClose,
}: ProposalCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const open = proposal.changes.filter((change) => change.status === 'open')
  // Slid back inside a root it would otherwise hang past, like the comment
  // card and for the same reason: the root clips, so a card at the edge
  // puts its verbs where no finger can reach them.
  const [slide, setSlide] = useState({ x: 0, y: 0 })
  useLayoutEffect(() => {
    const el = cardRef.current
    const parent = el?.offsetParent
    if (el == null || !(parent instanceof HTMLElement)) return
    const rect = el.getBoundingClientRect()
    const next = {
      x: Math.min(0, parent.clientWidth - CARD_EDGE_MARGIN_PX - (box.x + Math.ceil(rect.width))),
      y: Math.min(0, parent.clientHeight - CARD_EDGE_MARGIN_PX - (box.y + Math.ceil(rect.height))),
    }
    setSlide((prev) => (prev.x === next.x && prev.y === next.y ? prev : next))
  }, [box.x, box.y, box.width, proposal])

  useEffect(() => {
    cardRef.current?.focus()
  }, [])

  return (
    <div
      data-testid="proposal-card"
      ref={cardRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Proposed changes"
      // Chrome, not canvas: the root's gesture and touch guards recognise
      // the attribute, so a press on the card never falls through to the
      // hit-test under it.
      data-editor-overlay
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
      style={{
        position: 'absolute',
        left: Math.max(0, box.x + slide.x),
        top: Math.max(0, box.y + slide.y),
        width: Math.max(box.width, 240),
        // Above the ambient chrome (z-10), below the dialogs (z-30) — the
        // band CommentThreadCard measured.
        zIndex: 20,
        ...proposalCardStyle(theme),
      }}
      className="flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <ul className="min-w-0 flex-1 list-none space-y-1">
          {open.map((change) => (
            <li key={change.id} className="break-words">
              {describeChange(change, canvas)}
              {canConflict(change) && canvasChangeConflicts(change, canvas) ? (
                // Said, never enforced: decision 5 flags a collision and
                // leaves the choice to the person, so this is a note beside
                // the line rather than a disabled Adopt.
                <span className="opacity-70"> — needs a look</span>
              ) : null}
            </li>
          ))}
        </ul>
        <CardAction label="Close" onSelect={onClose}>
          <X className="size-3.5" />
        </CardAction>
      </div>
      {/* Words, not icons. Adopt and Dismiss are a decision with a
          consequence, and a pair of glyphs asks the reader to guess which
          one rewrites their board — the comment card's icons are standard
          lifecycle verbs, these are not. */}
      <div className="flex items-center justify-end gap-1">
        <DecideButton label="Dismiss" onSelect={() => onDecide('dismissed')} />
        <DecideButton label="Adopt" onSelect={() => onDecide('adopted')} />
      </div>
    </div>
  )
}

function DecideButton({
  label,
  onSelect,
}: {
  readonly label: string
  readonly onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="rounded border border-current/30 px-2 py-1 text-xs hover:bg-accent hover:text-foreground"
    >
      {label}
    </button>
  )
}

function canConflict(
  change: ProposedChange,
): change is Exclude<ProposedChange, { op: 'body.replace' }> {
  return change.op !== 'body.replace'
}

/**
 * What one change would do, in the words of the board rather than of the
 * schema — a person deciding a proposal is looking at their own document,
 * and an element's id is not what they call it.
 */
function describeChange(change: ProposedChange, canvas: SpatialCanvas): string {
  switch (change.op) {
    case 'node.add':
      return `Add ${nameOfNode(change.node)}`
    case 'node.remove':
      return `Remove ${nameOfNodeId(change.nodeId, canvas)}`
    case 'node.patch':
      return `${patchVerb(change.patch)} ${nameOfNodeId(change.nodeId, canvas)}`
    case 'edge.add':
      return 'Connect two nodes'
    case 'edge.remove':
      return 'Disconnect two nodes'
    case 'edge.patch':
      return 'Change a connection'
    case 'body.replace':
      return 'Replace a passage'
  }
}

/** Move / Resize / Reword / Restyle, from what the patch actually sets. */
function patchVerb(patch: Record<string, unknown>): string {
  const fields = Object.keys(patch)
  if (fields.some((field) => field === 'width' || field === 'height')) return 'Resize'
  if (fields.some((field) => field === 'x' || field === 'y')) return 'Move'
  if (fields.some((field) => field === 'text' || field === 'label')) return 'Reword'
  return 'Restyle'
}

function nameOfNodeId(id: string, canvas: SpatialCanvas): string {
  const node = canvas.nodes.find((candidate) => candidate.id === id)
  return node === undefined ? 'a node that is gone' : nameOfNode(node)
}

function nameOfNode(node: SpatialNode): string {
  const own =
    node.type === 'text'
      ? node.text
      : node.type === 'file'
        ? node.file
        : node.type === 'link'
          ? node.url
          : node.label
  const trimmed = own?.trim()
  if (trimmed === undefined || trimmed === '') return 'a node'
  const firstLine = trimmed.split('\n')[0] ?? trimmed
  return firstLine.length > NAME_MAX_CHARS
    ? `“${firstLine.slice(0, NAME_MAX_CHARS)}…”`
    : `“${firstLine}”`
}

function CardAction({
  label,
  onSelect,
  children,
}: {
  readonly label: string
  readonly onSelect: () => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onSelect}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}

/**
 * The card wears the proposal layer's own chrome — the palette entry, corner
 * and padding the renderer draws its bubble with — so the card reads as that
 * bubble opened rather than as a panel that replaced it. Indigo against the
 * comment layer's amber is the whole of what says which layer this is.
 */
function proposalCardStyle(theme: ResolvedTheme): CSSProperties {
  const { proposal } = theme === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE
  return {
    background: proposal.bubbleFill,
    color: editorTextFill(theme),
    border: `1px solid ${proposal.edge}`,
    borderRadius: COMMENT_BUBBLE_RADIUS_PX,
    padding: COMMENT_BUBBLE_PADDING_PX,
    // The bubble is only ever mounted focused, so its soft halo IS the
    // focus indicator — the UA's ring read as a second, heavier border.
    outline: 'none',
    boxShadow: `0 0 0 2px ${proposal.edge}55, 0 1px 3px rgba(0, 0, 0, 0.3)`,
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    fontSize: BODY_FONT_SIZE_PX,
    lineHeight: `${BODY_LINE_HEIGHT_PX}px`,
  }
}
