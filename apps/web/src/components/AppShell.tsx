import { Maximize2, Minimize2, Settings } from 'lucide-react'
import {
  lazy,
  type RefObject,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { HEADER_BUTTON_CLASS } from '../components/ui/header-button.js'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.js'
import { useFullscreen } from '../hooks/use-fullscreen.js'
import { useShellWorkspaceRows } from '../hooks/use-shell-workspace-rows.js'
import { useSettingsNudge } from '../hooks/useSettingsNudge.js'
import { settingsPath } from '../lib/app-routes.js'
import { browserWorkspaceIdOrNull } from '../lib/browser-workspace-id.js'
import { isSyncOff } from '../lib/connection-state.js'
import { beginPairingGrant } from '../lib/pairing-grant.js'
import { getShellConnection, subscribeShellStatus } from '../lib/shell-status-store.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { cn } from '../lib/utils.js'
import type { KeeperWorkspaces } from '../lib/workspace-switcher-source.js'
import { ConnectionStatus, connectionLabel } from './connection/ConnectionStatus.js'
import { WorkspaceMenu } from './shell/WorkspaceMenu.js'
import { formatRelative } from './workspace-files/format-relative.js'

// React.lazy for the same reason the browser page had it: the banner
// pulls in daemon-probe.ts and its Zod parsing, and only the Local popover
// ever opens it.
const DaemonDetectedBanner = lazy(() =>
  import('./migration/DaemonDetectedBanner.js').then((m) => ({
    default: m.DaemonDetectedBanner,
  })),
)

/**
 * The honest-detach floor for a moved workspace: a cold load whose silent
 * daemon renewal fails lands in the browser flow with the stored daemon
 * still configured. For a workspace that was MOVED to that daemon, resuming
 * browser keeper duties silently would hide that edits made here diverge
 * from the daemon copy — so the browser popover discloses the move. Only
 * when the recorded move targets the SAME daemon the browser still points
 * at: a move to a daemon this browser no longer uses is not this
 * connection's story. Reachability is unknown from here and deliberately
 * not claimed. And only for the workspace that was actually MOVED: this
 * browser keeps many workspaces, and the disclosure is a claim about one
 * record's data — a legacy promotion record that never named its source
 * cannot say which, so it discloses nothing rather than accusing whichever
 * workspace happens to be active.
 */
function PromotedElsewhereNotice({
  settingsStore,
}: {
  settingsStore: ReturnType<typeof createUserSettingsStore>
}) {
  const settings = settingsStore.load()
  const promotion = settings.migration.promotion
  const storedDaemon = settings.storage.daemonBaseUrl
  if (
    promotion === undefined ||
    !promotion.ok ||
    storedDaemon === undefined ||
    promotion.daemonBaseUrl !== storedDaemon ||
    promotion.sourceWorkspaceId === undefined ||
    promotion.sourceWorkspaceId !== browserWorkspaceIdOrNull()
  ) {
    return null
  }
  return (
    <p data-testid="promoted-elsewhere-notice" className="text-muted-foreground">
      This workspace has been moved to the daemon at{' '}
      <span className="font-mono text-xs">{storedDaemon.replace(/^https?:\/\//, '')}</span>. Changes
      made here stay in this browser until you move it again from Settings.
    </p>
  )
}

/**
 * ADR-0023: a daemon workspace this browser holds a replica of says so where
 * the workspace is named — and since the offline read shipped, the copy may
 * also promise what the replica now delivers: a read-only view when the
 * daemon cannot be reached. Silent for a workspace with no registry entry,
 * and while the row (hence the id) has not loaded: a claim needs its
 * subject.
 */
function ReplicaCacheNotice({
  settingsStore,
  workspaceId,
}: {
  settingsStore: ReturnType<typeof createUserSettingsStore>
  workspaceId: string | null
}) {
  if (workspaceId === null) return null
  const replica = settingsStore.load().storage.replicas?.[workspaceId]
  if (replica === undefined) return null
  const age = formatRelative(replica.syncedAt)
  return (
    <p data-testid="replica-cache-notice" className="text-muted-foreground">
      A copy of this workspace is cached in this browser, and opens read-only when the daemon cannot
      be reached.{age === '' ? '' : ` Last synced ${age}.`}
    </p>
  )
}

export interface AppShellProps {
  readonly daemon: boolean
  /**
   * Switches the app to the browser flow. The App branch owns this, so
   * a branch without the escape (settings, the browser flow itself) leaves it
   * unset and the chip drops the two actions that depend on it.
   */
  readonly onWorkInBrowser?: () => void
  /**
   * The keeper's half of the workspace switcher — where its workspaces come
   * from and what a switch means for it. Absent on a branch that has no
   * workspace to name (the invalid-config and pairing-error screens), and the
   * shell then states no subject rather than an empty one.
   *
   * Passed in rather than built here: the two keepers read their registries
   * from entirely different places, and a shell that knew both would import
   * the browser's IndexedDB index and the daemon's HTTP client into every
   * page's chrome.
   */
  readonly workspaces?: KeeperWorkspaces
}

/**
 * The app-level chrome, deliberately minimal: the signature mark and the
 * alpha honesty chip on the left, fullscreen and the settings gear (+
 * attention dot) on the right. Nothing else ever moves in here — context
 * and tools stay in the page's own surface, always visible (see DESIGN.md's
 * shell rule). Pages mount this shared component instead of owning any
 * brand, connection, fullscreen or settings chrome themselves.
 *
 * Fullscreen is the shell's because its subject is the APP — how much of
 * the screen it gets — which is the one thing that does not change when a
 * document opens. In fullscreen this row steps aside (the document's top
 * bar does too, reading the same state), leaving one floating way back out
 * beside Escape.
 *
 * The mark is the row's SUBJECT and its one state carrier. Left of the
 * spacer is "what you are working in"; right of it is the app and its own
 * state. There is no connection chip any more — a workspace's keeper and its
 * session are things about the workspace, so they belong on the thing that
 * names it rather than on a second widget at the other end of the row.
 */
/**
 * The way back out of fullscreen.
 *
 * Both chrome rows are gone — the extra space is what fullscreen is
 * FOR — so the way back has to float. Escape still works natively.
 *
 * It floats at the BOTTOM, because rotating puts the device's camera edge
 * on a SIDE of the screen and never its bottom. The web exposes the safe
 * area only as a uniform band per edge, never the cutout's position along
 * it, so a control on the top edge must either collide with the punch-hole
 * or step back from the whole band on every device that has one — both
 * were seen on a phone. What is left down here is the home indicator, a
 * band that genuinely IS the full width. Left, since the canvas keeps its
 * overview at bottom-right.
 *
 * The corner is the default, and the lift is the exception, because the
 * bottom edge is also where the editing surfaces keep a strip. The canvas
 * dock is centred, so its left edge walks toward the corner only as the
 * viewport narrows: below 407px it reaches this control, and above it the
 * dock is nowhere near — where a control floating a strip's height up,
 * with empty space beneath it, reads as unanchored rather than as placed.
 *
 * 445 is arithmetic, not taste. The dock is centred at 333px, so its left
 * edge is (vw - 333) / 2; this control spans 12..44; 8px of clearance
 * wants vw >= 333 + 112. `declares a corner breakpoint that still clears
 * the dock` reads the number back out of this class and re-measures it
 * against the real dock, so widening the dock fails there rather than on
 * someone's phone — which is exactly how the pen's tool button moved it
 * from 407.
 *
 * Narrower than 357 the dock stops growing (it is capped to the editor's
 * width less a gutter, and its tools scroll), so its left edge parks at
 * 12 and this control's horizontal clearance is gone for good — which is
 * the band the 70px lift below covers.
 *
 * 70px is that strip: the dock's own 0.75rem offset, its 46px, and the gap
 * again. It clears the markdown formatting bar (44px) too, so no page has
 * to say anything about either.
 */
function ExitFullscreenControl({
  buttonRef,
  onExit,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>
  onExit: () => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label="Exit fullscreen"
      data-testid="shell-exit-fullscreen"
      onClick={onExit}
      className={cn(
        HEADER_BUTTON_CLASS,
        'fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom))] max-[445px]:bottom-[calc(70px+env(safe-area-inset-bottom))] left-[calc(0.75rem+env(safe-area-inset-left))] z-50 border bg-background/80 shadow-sm backdrop-blur',
      )}
    >
      <Minimize2 aria-hidden="true" className="size-4" />
    </button>
  )
}

/**
 * Hands focus to whichever control replaced the one that was just activated.
 *
 * The toggle UNMOUNTS it — entering removes the shell row, exiting removes
 * the floating control — and a removed focused element drops focus to
 * `<body>`, leaving a keyboard user to tab back from nothing.
 */
function useFullscreenFocusHandoff(isFullscreen: boolean) {
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const exitRef = useRef<HTMLButtonElement | null>(null)
  const wasFullscreenRef = useRef(false)
  useEffect(() => {
    if (isFullscreen) {
      wasFullscreenRef.current = true
      exitRef.current?.focus()
      return
    }
    if (!wasFullscreenRef.current) return
    wasFullscreenRef.current = false
    toggleRef.current?.focus()
  }, [isFullscreen])
  return { toggleRef, exitRef }
}

/**
 * The shell's MODE, and nothing else.
 *
 * Fullscreen is a whole different presentation rather than a row with pieces
 * missing — both chrome rows are gone, which is what fullscreen is FOR — so
 * it is its own component and this is the one place that chooses between
 * them. The focus handoff spans both, which is why it sits here.
 */
export function AppShell(props: AppShellProps) {
  const fullscreen = useFullscreen()
  const { toggleRef, exitRef } = useFullscreenFocusHandoff(fullscreen.isFullscreen)
  if (fullscreen.isFullscreen) {
    return <ExitFullscreenControl buttonRef={exitRef} onExit={fullscreen.toggle} />
  }
  return <ShellBar {...props} fullscreen={fullscreen} toggleRef={toggleRef} />
}

/** The chrome row: the mark, the alpha badge, and the two controls. */
function ShellBar({
  daemon,
  onWorkInBrowser,
  workspaces,
  fullscreen,
  toggleRef,
}: AppShellProps & {
  fullscreen: ReturnType<typeof useFullscreen>
  toggleRef: RefObject<HTMLButtonElement | null>
}) {
  const navigate = useNavigate()
  const location = useLocation()
  // Read fresh rather than cached in state: the store is a thin localStorage
  // accessor, and a cached snapshot would go stale behind the settings page.
  const [settingsStore] = useState(() => createUserSettingsStore())
  // Published by whichever page holds a live document session; `null` on an
  // index or settings page, which has none to describe.
  const connection = useSyncExternalStore(subscribeShellStatus, getShellConnection)
  // Sync off means the daemon rejected the session and re-pairing is the only
  // way out, so it counts as disconnected for the attention dot. A transient
  // reconnect does not — it recovers on its own.
  const nudge = useSettingsNudge(daemon && !(connection !== null && isSyncOff(connection.state)))
  const daemonBaseUrl = connection?.daemonBaseUrl
  const {
    rows,
    handleInAddress: workspaceHandleInAddress,
    activeRow,
    activeName,
    applyRename,
    applyCounts,
  } = useShellWorkspaceRows(workspaces, location.pathname)

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-chrome pointer-coarse:h-12">
      {/* ONE carrier, and one trigger. The mark IS the switcher ("Mark as
          Switcher"): it names the workspace in its accessible name, opens the
          popover that lists the others, and carries the session state when a
          page published one. It opens on every page — the workspace is a fact
          everywhere, so there is always something for the popover to say —
          which is why the plain-link-home shape is gone. It gained no
          replacement destination: a whole-account view of every document is a
          state this product does not have, and leaving a document is the
          page's own affordance. */}
      <ConnectionStatus
        state={connection?.state ?? null}
        daemonBaseUrl={daemonBaseUrl}
        lastWrittenAt={connection?.lastWrittenAt ?? null}
        {...(activeName === undefined ? {} : { workspaceName: activeName })}
        workspaceMenu={
          // Rendered whenever a keeper published a switcher, INCLUDING when
          // the address names no workspace. A daemon holding nothing serves
          // `/`, and this menu is the only place creation is offered — so
          // requiring a handle here left a fresh daemon with no way to make
          // its first workspace, which is the one thing this increment set out
          // to make possible. With no handle the menu simply has no current
          // row: the rename section is already behind `active !== undefined`,
          // so it degrades to a list and a create button on its own.
          workspaces ? (
            <WorkspaceMenu
              current={workspaceHandleInAddress}
              workspaces={rows}
              source={workspaces.source}
              onSwitch={workspaces.onSwitch}
              sessionLabel={connectionLabel(connection?.state ?? null)}
              onRenamed={applyRename}
              onCounted={applyCounts}
            />
          ) : undefined
        }
        onRepair={
          daemonBaseUrl === undefined
            ? undefined
            : () => {
                void beginPairingGrant({
                  daemonBaseUrl,
                  hostedOrigin: window.location.origin,
                  sessionStorage: window.sessionStorage,
                  navigate: (url) => window.location.assign(url),
                })
              }
        }
        onWorkInBrowser={onWorkInBrowser}
      >
        {connection?.state.keeper === 'daemon' && (
          <ReplicaCacheNotice
            settingsStore={settingsStore}
            workspaceId={activeRow?.workspaceId ?? null}
          />
        )}
        {connection?.state.keeper === 'browser' && (
          <>
            <p className="text-muted-foreground">
              Connect a daemon (MCP) for automatic checkpoints, variations and merging. Once
              connected, you can move this workspace to it from Settings — documents, their history
              and images together.
            </p>
            <PromotedElsewhereNotice settingsStore={settingsStore} />
            <Suspense fallback={null}>
              <DaemonDetectedBanner
                settingsStore={settingsStore}
                fetch={window.fetch.bind(window)}
              />
            </Suspense>
          </>
        )}
      </ConnectionStatus>
      <AlphaBadge />
      <span className="min-w-0 flex-1" />
      {/* Hidden rather than disabled where the browser has no element
          fullscreen (iPhone Safari — video-only): a disabled control still
          claims row space and invites a tap that can never work, and there
          is nothing the user could change to enable it. */}
      {/* Hidden rather than disabled where the browser has no element
          fullscreen (iPhone Safari — video-only): a disabled control still
          claims row space and invites a tap that can never work, and there
          is nothing the user could change to enable it. */}
      {fullscreen.supported && (
        <FullscreenButton buttonRef={toggleRef} onEnter={fullscreen.toggle} />
      )}
      <SettingsButton
        nudge={nudge}
        onOpen={() =>
          navigate(settingsPath(), {
            state: { from: `${location.pathname}${location.search}` },
          })
        }
      />
    </header>
  )
}

/**
 * The gear, and the dot that can read as an alarm.
 *
 * Naming the dot's cause turns it from "did I break something?" into a task
 * the user can choose to do — so the label carries it rather than the dot
 * standing alone.
 */
function SettingsButton({ nudge, onOpen }: { nudge: boolean; onOpen: () => void }) {
  const label = nudge ? 'Settings — a setup step is waiting' : 'Settings'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="shell-settings"
      onClick={onOpen}
      className={HEADER_BUTTON_CLASS}
    >
      {/* The dot hangs off the GLYPH, not off the button. The button is
          32px on a mouse and 44px on a finger while the gear stays 16px,
          so a dot pinned to the button's corner drifts away from the
          thing it is about as the button grows — on a phone it sat 4px
          clear of the gear and 3.5px from the row's top edge, reading as
          a badge on the corner of the screen. */}
      <span className="relative inline-flex">
        <Settings className="size-4" />
        {nudge && (
          <span
            data-testid="settings-nudge"
            aria-hidden="true"
            className="absolute -right-1 -top-1 size-2 rounded-full bg-[#3b6ecc] ring-2 ring-background"
          />
        )}
      </span>
    </button>
  )
}

/** What the product is still promising, and what it is not. */
function AlphaBadge() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Alpha preview notes"
          className="shrink-0 rounded-full border border-amber-600/55 px-1.5 font-mono text-[10px] leading-4 tracking-wide text-amber-600 hover:bg-amber-600/10 dark:border-amber-500/55 dark:text-amber-500"
        >
          ALPHA
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-sm">
        <p className="font-medium">Alpha preview</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Data durability is not guaranteed yet. Browser storage can be evicted by the device —
          export what matters, or protect it with persistent storage and a daemon.
        </p>
        <Link
          to={settingsPath('data')}
          className="mt-2 inline-block text-xs font-semibold text-primary hover:underline"
        >
          Protect your data
        </Link>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Enter fullscreen. The way back out is `ExitFullscreenControl`, which
 * replaces the whole row rather than sitting in it.
 */
function FullscreenButton({
  buttonRef,
  onEnter,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>
  onEnter: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label="Fullscreen"
          data-testid="shell-fullscreen"
          onClick={onEnter}
          className={HEADER_BUTTON_CLASS}
        >
          <Maximize2 aria-hidden="true" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Fullscreen</TooltipContent>
    </Tooltip>
  )
}
