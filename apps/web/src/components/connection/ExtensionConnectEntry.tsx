import { lazy, Suspense, useState } from 'react'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'

const ExtensionConnectOption = lazy(() =>
  import('./ExtensionConnectOption.js').then((m) => ({ default: m.ExtensionConnectOption })),
)

/**
 * The extension's connect option, loaded with the first page that offers it
 * rather than with the app. Every place that says there is no daemon offers
 * it: the workspace popover, Settings > Connections, and an empty browser
 * workspace's landing page.
 */
export function ExtensionConnectEntry({
  settingsStore,
  lead,
}: {
  lead?: string
  /** The page's own store where it has one; the settings are one record either way. */
  settingsStore?: ReturnType<typeof createUserSettingsStore>
}) {
  const [ownStore] = useState(() => settingsStore ?? createUserSettingsStore())
  return (
    <Suspense fallback={null}>
      <ExtensionConnectOption
        settingsStore={settingsStore ?? ownStore}
        {...(lead === undefined ? {} : { lead })}
      />
    </Suspense>
  )
}
