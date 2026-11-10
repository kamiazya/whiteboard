import { installOkfCoreForTests } from './install.js'

// The web app's realm reads the build-time names of the same two switches
// (apps/web/src/lib/spatial/layout-core-settings.ts).
await installOkfCoreForTests({
  okf: process.env.VITE_WHITEBOARD_CORE_OKF,
  mismatch: process.env.VITE_WHITEBOARD_CORE_MISMATCH,
})
