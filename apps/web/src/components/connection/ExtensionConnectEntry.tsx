import { lazy, type ReactNode, Suspense, useState } from 'react'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'

const ExtensionConnectOption = lazy(() =>
  import('./ExtensionConnectOption.js').then((m) => ({ default: m.ExtensionConnectOption })),
)

/**
 * The extension's connect option, loaded with the first page that offers it
 * rather than with the app. Every place that says there is no daemon offers
 * it: the workspace popover, Settings > Connections, and an empty browser
 * workspace's landing page. It renders nothing where the extension does not
 * answer, so each of those reads as it always did without one.
 */
export function ExtensionConnectEntry({
  settingsStore,
  lead,
  absent,
}: {
  lead?: string
  /** Offered instead where the extension does not answer. */
  absent?: ReactNode
  /** The page's own store where it has one; the settings are one record either way. */
  settingsStore?: ReturnType<typeof createUserSettingsStore>
}) {
  const [ownStore] = useState(() => settingsStore ?? createUserSettingsStore())
  return (
    <Suspense fallback={null}>
      <ExtensionConnectOption
        settingsStore={settingsStore ?? ownStore}
        {...(lead === undefined ? {} : { lead })}
        {...(absent === undefined ? {} : { absent })}
      />
    </Suspense>
  )
}
