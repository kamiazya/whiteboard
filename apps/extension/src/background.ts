import { admittedMatches } from './manifest.js'
import { type ExtensionApi, installRelay } from './relay.js'

declare const chrome: ExtensionApi

// The list the browser enforces is the one the relay checks against, read
// back from this build's own manifest.
installRelay(chrome, admittedMatches(chrome.runtime.getManifest()))
