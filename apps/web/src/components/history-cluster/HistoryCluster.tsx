/**
 * The history cluster — every Loro-timeline affordance in one group:
 * step undo/redo, and (when the daemon capability exists) the
 * version-history panel.
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
import { History, Redo2, Undo2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { DOCK_BUTTON_CLASS } from '@/components/ui/dock-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { VersionPanel } from '../workspace-top-bar/VersionPanel.js'

export interface HistoryClusterVersionsProps {
  readonly workspaceId: string
  readonly path: string
  readonly onRestored?: () => void
  readonly refreshSignal?: number
  readonly versionPanelExtra?: ReactNode
}

export interface HistoryClusterProps {
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly canUndo: boolean
  readonly canRedo: boolean
  /** Present only when the version capability exists (daemon-backed pages). */
  readonly versions?: HistoryClusterVersionsProps
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
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

export function HistoryCluster({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  versions,
}: HistoryClusterProps) {
  const [versionOpen, setVersionOpen] = useState(false)
  const versionPanelRef = useRef<HTMLDivElement | null>(null)

  // Close the version panel on outside clicks. Radix dialogs (the restore
  // confirmation) portal into document.body — outside this subtree — so
  // clicks inside any dialog count as "inside", or confirming a restore
  // would also close the panel behind it.
  useEffect(() => {
    if (!versionOpen) return
    const onClick = (e: MouseEvent) => {
      const panel = versionPanelRef.current
      if (!panel) return
      const target = e.target as Node | null
      if (target && !panel.contains(target)) {
        const targetEl = e.target as HTMLElement
        const isTrigger = targetEl.closest('[data-version-trigger]')
        const isInPortalDialog = targetEl.closest('[role="dialog"], [role="alertdialog"]')
        if (!isTrigger && !isInPortalDialog) setVersionOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [versionOpen])

  return (
    <div
      data-editor-overlay
      data-testid="history-cluster"
      role="toolbar"
      aria-label="History"
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
      {versions && (
        <>
          <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-version-trigger
                aria-label="Version history"
                aria-expanded={versionOpen}
                onClick={() => setVersionOpen((v) => !v)}
                className={cn(CLUSTER_BUTTON_CLASS, versionOpen && 'bg-accent text-foreground')}
              >
                <History aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Version history</TooltipContent>
          </Tooltip>
          {versionOpen && (
            <div
              data-testid="history-version-panel"
              // Opens UPWARD from the cluster, origin-aware at the trigger
              // corner (never scale(0) — see DESIGN.md Motion).
              className="absolute bottom-[calc(100%+6px)] left-0 origin-bottom-left animate-in fade-in-0 zoom-in-[0.98] duration-(--motion-duration-normal) ease-(--motion-ease-out)"
            >
              <VersionPanel
                panelRef={versionPanelRef}
                workspaceId={versions.workspaceId}
                path={versions.path}
                onRestored={versions.onRestored}
                refreshSignal={versions.refreshSignal}
                versionPanelExtra={versions.versionPanelExtra}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
