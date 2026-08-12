import { useSyncExternalStore } from 'react'
import {
  applyUpdate,
  checkForUpdates,
  getSwStatus,
  subscribeSwStatus,
} from '../../pwa/sw-status-store.js'

const BUTTON_CLASS =
  'shrink-0 rounded-md border border-primary px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/5'

/**
 * The re-entry point for a service-worker update after the toast was
 * dismissed with "Later", plus a manual check between the scheduler's
 * automatic ones. Without a registration (dev, unsupported browsers, the
 * daemon-served page) it degrades to a passive one-liner.
 */
export function AppVersionRow() {
  const status = useSyncExternalStore(subscribeSwStatus, getSwStatus)

  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          App version
          <span
            className={`font-mono text-[11px] font-normal ${
              status.updateReady
                ? 'text-primary'
                : status.supported
                  ? 'text-green-600 dark:text-green-500'
                  : 'text-muted-foreground'
            }`}
          >
            {!status.supported
              ? 'managed by the environment'
              : status.updateReady
                ? 'update ready'
                : status.checking
                  ? 'checking…'
                  : 'up to date'}
          </span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {!status.supported
            ? 'This environment applies updates on its own.'
            : status.updateReady
              ? 'A new version is downloaded and waiting.'
              : 'Checked automatically on focus and on a timer.'}
        </p>
      </div>
      {status.supported && status.updateReady && (
        <button type="button" className={BUTTON_CLASS} onClick={() => void applyUpdate()}>
          Update now
        </button>
      )}
      {status.supported && !status.updateReady && !status.checking && (
        <button type="button" className={BUTTON_CLASS} onClick={() => void checkForUpdates()}>
          Check for updates
        </button>
      )}
    </div>
  )
}
