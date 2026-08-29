import { startBootSequence } from './boot.js'
import { applyThemeClass, readPersistedTheme, resolveTheme } from './hooks/useThemeMode.js'
import './index.css'
import { initInstallPromptCapture } from './lib/install-prompt-store.js'
import { installMobileAppShellGuards } from './lib/mobile-app-shell.js'
import { purgeLegacyReconnectCredentials } from './lib/purge-legacy-reconnect-credentials.js'
import './pwa/bootstrap.js'

// Unconditional, ahead of anything else: removes a credential a pre-removal
// build may have left in localStorage, independent of whether this tab ever
// opens the IndexedDB store (see purge-legacy-reconnect-credentials.ts).
purgeLegacyReconnectCredentials()

// beforeinstallprompt fires once, early — arm the capture before React mounts
// so the settings journey's Install step can replay it later.
initInstallPromptCapture()

// Apply the persisted theme class before React mounts so the first paint
// matches the user's saved preference (avoids a light→dark flash on reload).
applyThemeClass(resolveTheme(readPersistedTheme()))

// Before React mounts, so no gesture can slip in during hydration: cancels
// Safari's proprietary pinch events, which page-zoom regardless of the
// viewport meta or touch-action (see mobile-app-shell.ts).
installMobileAppShellGuards()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

// The full chain — font load, workspace-id resolve, splash dismissal, render
// — lives in boot.ts, so the resolver-rejection path is testable through the
// real sequence. See its module comment for why a rejection there must not
// block this call.
void startBootSequence({ rootEl })
