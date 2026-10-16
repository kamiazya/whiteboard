import { useEffect, useState, useSyncExternalStore } from 'react'
import { createAppBadgeWriter } from '../../lib/app-badge.js'
import { getShellConnection, subscribeShellStatus } from '../../lib/shell-status-store.js'
import { UnsavedChangesNotice } from './UnsavedChangesNotice.js'
import { WriteRefusedNotice } from './WriteRefusedNotice.js'

/**
 * What the keeper says about the person's writes: a change it refused, and
 * changes it has not received yet — in the window, and on the installed
 * app's badge. All read stores a document page fills, so every frame that
 * can hold a document page mounts this one component — a frame that mounted
 * only one notice, or neither, would roll a refused edit back in silence and
 * let the tab close over unsaved changes, and a page that had to raise the
 * badge itself would get none the day it forgot to.
 */
export function KeeperNotices() {
  useShellAppBadge()
  return (
    <>
      <UnsavedChangesNotice />
      <WriteRefusedNotice />
    </>
  )
}

/**
 * One badge writer per window, fed by the shell store. A window going away
 * takes back a badge it raised — on unmount, and on `pagehide`, since closing
 * the window runs no React cleanup — and a page restored from the
 * back-forward cache raises it again.
 */
function useShellAppBadge(): void {
  const state = useSyncExternalStore(subscribeShellStatus, getShellConnection)?.state ?? null
  const [writer] = useState(createAppBadgeWriter)
  useEffect(() => writer.write(state), [writer, state])
  useEffect(() => {
    const hide = () => writer.write(null)
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) writer.write(getShellConnection()?.state ?? null)
    }
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    return () => {
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', show)
      writer.write(null)
    }
  }, [writer])
}
