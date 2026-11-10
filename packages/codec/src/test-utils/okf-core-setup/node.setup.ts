import { installOkfCoreForTests } from './install.js'

// A Node-hosted realm's switch is the daemon's own: WHITEBOARD_CORE_OKF and
// WHITEBOARD_CORE_MISMATCH.
await installOkfCoreForTests({
  okf: process.env.WHITEBOARD_CORE_OKF,
  mismatch: process.env.WHITEBOARD_CORE_MISMATCH,
})
