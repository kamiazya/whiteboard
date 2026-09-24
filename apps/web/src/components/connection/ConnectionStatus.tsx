/**
 * The ONE connection-state affordance. The SIGNATURE MARK signals the state;
 * every sentence-shaped explanation and recovery action lives in its popover
 * — no standing banners.
 *
 * The mark, and not a chip beside it, because the row had no subject: the
 * mark meant "home" and nothing else while a separate chip on the right
 * answered "is my work safe" about a workspace nothing on screen named. One
 * carrier now answers both, and the row reads left to right as "this
 * workspace" rather than as two unrelated widgets. `ShellMark` owns the paint
 * and the motion; this file owns what the popover says and offers.
 *
 * Keeper `browser` — the workspace is kept in this browser and nowhere else.
 * `children` hosts page-supplied extras (daemon detection, capability hint)
 * inside the popover.
 *
 * Keeper `daemon` reports the live session's health on top:
 * - `synced`   — live sync running.
 * - `reconnecting` — live sync is not running: the transport has not come up
 *                yet, dropped, or failed. Edits made meanwhile are not lost:
 *                the session re-sends the whole document when the transport
 *                returns, which is what makes that claim true — a backend
 *                whose socket is closed drops the delta it was handed.
 * - `sync-off` — the session was rejected. The chip turns attention-colored
 *                and the popover carries the two ways forward (re-pair / work
 *                in the browser). A polite sr-only live region announces the
 *                transition so dropping the old role="alert" banner loses no
 *                assistive-tech signal.
 */
import type { ReactNode } from 'react'
import {
  type ConnectionState,
  isSyncOff,
  notKeepingAnnouncement,
  type SessionHealth,
} from '../../lib/connection-state.js'
import type { StorageHealth } from '../../lib/storage-health.js'
import { ShellMark } from '../shell/ShellMark.js'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'
import {
  BrowserStoragePanel,
  DaemonReconnectingPanel,
  DaemonSyncedPanel,
  DaemonWriteFailedPanel,
  SyncOffPanel,
} from './connection-panels.js'

export interface ConnectionStatusProps {
  /**
   * `null` on a page that holds no live session. The mark still opens —
   * the workspace is a fact on every page, so there is always something to
   * say — it simply has no session word to carry.
   */
  readonly state: ConnectionState | null
  /** Shown in the synced popover so the user knows which daemon holds the data. */
  readonly daemonBaseUrl?: string
  /** sync-off only: starts the pairing grant flow on the daemon's /pair page. */
  readonly onRepair?: () => void
  /** sync-off only: switches to the documents kept in this browser. */
  readonly onWorkInBrowser?: () => void
  /** browser only: page-supplied popover extras (daemon detection, capability hint). */
  readonly children?: ReactNode
  /**
   * browser only: when the open document's writes last landed, ISO-8601.
   * Said in the popover and nowhere else — the mark draws nothing for a
   * write that landed, so this is where "saved" is answered, on asking.
   */
  readonly lastWrittenAt?: string | null
  /** What the mark's accessible name states. The popover's head is the menu's own. */
  readonly workspaceName?: string
  /** The workspace section, composed by the shell and rendered above the session's own. */
  readonly workspaceMenu?: ReactNode
}

/**
 * The word the mark cannot say.
 *
 * A chip carried its label beside its dot; a 26x16 signature has room for
 * neither. The label therefore moves into the accessible name and the
 * popover's header — which is load-bearing rather than tidy, because
 * `reconnecting` and `sync-off` share the `attention` tone and the chip's
 * word was what told them apart for a sighted reader. The mark separates
 * them by motion instead; assistive tech reads this.
 */
const SESSION_LABEL: Record<SessionHealth, string> = {
  synced: 'Synced',
  reconnecting: 'Reconnecting',
  'sync-off': 'Sync off',
  'write-failed': 'Not saved yet',
}

/**
 * The word the mark cannot say, for whoever needs to render it. Exported
 * because the popover's head moved into `WorkspaceMenu` — the head is an
 * editable name now — and the session word sits on that same row.
 */
export function connectionLabel(state: ConnectionState | null): string | null {
  if (state === null) return null
  return state.keeper === 'browser' ? STORAGE_LABEL[state.storage] : SESSION_LABEL[state.session]
}

/**
 * The browser keeper's word. `ok` stays the bare keeper name: nothing is
 * wrong, so there is nothing to add. The two conditions name what the mark
 * only shapes.
 */
const STORAGE_LABEL: Record<StorageHealth, string> = {
  ok: 'Browser',
  stuck: 'Browser — still writing',
  failed: 'Browser — write failed',
}

/**
 * The state has no word on SCREEN, so the accessible name carries it — the
 * one place a colour-and-motion signal must not be the only signal.
 *
 * The workspace's NAME rather than the bare word: the design record puts the
 * name here precisely so the shell states it without drawing it, and the
 * session word joins it when a page published one.
 */
function markAriaLabel(workspaceName: string | undefined, label: string | null): string {
  const session = label === null ? '' : ` — ${label}`
  return workspaceName === undefined
    ? `Workspace${session}`
    : `Workspace: ${workspaceName}${session}`
}

/**
 * The workspace block comes FIRST and carries its own head, because that head
 * is an editable name and editing belongs to the component that owns the
 * rename. Without one — no workspace known — the session word still needs
 * stating, so the bare head stands in.
 */
function PopoverHead({
  label,
  workspaceMenu,
}: {
  label: string | null
  workspaceMenu: ReactNode | undefined
}) {
  if (workspaceMenu !== undefined) return <div className="mb-2 text-sm">{workspaceMenu}</div>
  if (label === null) return null
  return <p className="mb-2 border-b pb-2 text-xs font-medium text-muted-foreground">{label}</p>
}

export function ConnectionStatus({
  state,
  daemonBaseUrl,
  onRepair,
  onWorkInBrowser,
  children,
  lastWrittenAt,
  workspaceName,
  workspaceMenu,
}: ConnectionStatusProps) {
  const label = connectionLabel(state)
  const syncOff = state !== null && isSyncOff(state)
  // Empty while the keeper is keeping: the region has to exist BEFORE the
  // message, but an empty one must not claim a name either. Both not-keeping
  // states announce, because both mean the same thing to the person typing.
  const announcement = notKeepingAnnouncement(state)

  return (
    <Popover>
      {/* Always mounted, for the same reason as the busy line in
          WorkspaceTopBar: sync going off is a CHANGE, and a live region that
          appears together with its first message may never be announced. */}
      <span role="status" aria-label={announcement || undefined} className="sr-only">
        {announcement}
      </span>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="shell-mark-trigger"
          // The state has no word on screen, so the accessible name carries
          // it — the one place a colour-and-motion signal must not be the
          // only signal.
          // The workspace's NAME rather than the bare word: the design
          // record puts the name here precisely so the shell states it
          // without drawing it, and the session word joins it when a page
          // published one.
          aria-label={markAriaLabel(workspaceName, label)}
          {...(label === null ? {} : { title: label })}
          className="flex shrink-0 items-center justify-center rounded-md p-1 text-foreground/70 transition-colors duration-(--motion-duration-normal) ease-(--motion-ease-out) hover:bg-accent hover:text-foreground"
        >
          {state === null ? <ShellMark /> : <ShellMark state={state} />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" data-testid="shell-mark-popover">
        {/* The workspace block comes FIRST and carries its own head, because
            that head is an editable name and editing belongs to the component
            that owns the rename. Without one — no workspace known — the
            session word still needs stating, so the bare head stands in. */}
        <PopoverHead label={label} workspaceMenu={workspaceMenu} />
        <DaemonSyncedPanel state={state} daemonBaseUrl={daemonBaseUrl}>
          {children}
        </DaemonSyncedPanel>
        <DaemonReconnectingPanel state={state} />
        <DaemonWriteFailedPanel state={state} />
        <BrowserStoragePanel state={state} lastWrittenAt={lastWrittenAt ?? null}>
          {children}
        </BrowserStoragePanel>
        <SyncOffPanel show={syncOff} onRepair={onRepair} onWorkInBrowser={onWorkInBrowser} />
      </PopoverContent>
    </Popover>
  )
}
