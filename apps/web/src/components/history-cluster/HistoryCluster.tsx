/**
 * The step cluster — undo and redo for the spatial editor.
 *
 * Version history LEFT this group: it belongs to the document rather than to
 * one editor, so its entry point is the top bar and its panel is a column of
 * the editor row. What stays here is the pair whose lifetime is the editing
 * session — a markdown document keeps its own undo in CodeMirror.
 *
 * This component is deliberately UNPOSITIONED: it renders as the bottom
 * dock's leading group (SpatialEditor's `paletteLeading` slot), because
 * independently positioned floating islands collide as tools grow — on a
 * phone the old bottom-left cluster overlapped the widening palette. The
 * dock is the single layout authority; this group only brings content.
 * History stays visually separated from creation/mode tools by the dock's
 * divider (the recorded OOUI palette rule).
 *
 * Feel: press feedback fires on pointer-down (`:active` scale, fast
 * token), touch targets grow to >=44px on coarse pointers, and a disabled
 * direction keeps answering via tooltip instead of going dead —
 * aria-disabled, never the native disabled attribute.
 *
 * Marked `data-editor-overlay` so the canvas root's gesture handlers
 * ignore presses originating here (see SpatialEditor's isOverlayEvent).
 */

import { Redo2, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { DOCK_BUTTON_CLASS } from '@/components/ui/dock-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isMacPlatform } from '../../lib/platform.js'

export interface HistoryClusterProps {
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly canUndo: boolean
  readonly canRedo: boolean
}

const IS_MAC = isMacPlatform()
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+'
const MOD_KEY = IS_MAC ? 'Meta' : 'Control'

export const CLUSTER_BUTTON_CLASS = DOCK_BUTTON_CLASS

function StepButton({
  label,
  shortcut,
  keyshortcuts,
  enabled,
  onPress,
  children,
}: {
  label: string
  shortcut: string
  keyshortcuts: string
  enabled: boolean
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-keyshortcuts={keyshortcuts}
          aria-disabled={!enabled}
          onClick={() => {
            if (enabled) onPress()
          }}
          className={cn(CLUSTER_BUTTON_CLASS, !enabled && 'text-muted-foreground/40')}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {enabled ? `${label} (${shortcut})` : `Nothing to ${label.toLowerCase()}`}
      </TooltipContent>
    </Tooltip>
  )
}

export function HistoryCluster({ onUndo, onRedo, canUndo, canRedo }: HistoryClusterProps) {
  return (
    <div
      data-editor-overlay
      data-testid="history-cluster"
      role="toolbar"
      aria-label="Undo and redo"
      className="relative flex items-center gap-0.5"
    >
      <StepButton
        label="Undo"
        shortcut={`${MOD_LABEL}Z`}
        keyshortcuts={`${MOD_KEY}+Z`}
        enabled={canUndo}
        onPress={onUndo}
      >
        <Undo2 aria-hidden="true" className="size-4" />
      </StepButton>
      <StepButton
        label="Redo"
        shortcut={`${MOD_LABEL}⇧Z`}
        keyshortcuts={`${MOD_KEY}+Shift+Z`}
        enabled={canRedo}
        onPress={onRedo}
      >
        <Redo2 aria-hidden="true" className="size-4" />
      </StepButton>
    </div>
  )
}
