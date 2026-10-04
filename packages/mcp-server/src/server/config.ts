import { resolve } from 'node:path'
import {
  getDataDir,
  resetDataDirForTests,
  resolveDataDir,
  setDataDirForTests,
  WHITEBOARD_ROOT,
} from '../shared/data-dir-secure.js'

// Re-export the create+secure data-dir resolution from the shared layer so
// all existing server/store importers keep their '../server/config.js' import
// paths unchanged. The definitions live in the shared layer so daemon files
// can depend on them without importing upward into the server layer.
export { getDataDir, resetDataDirForTests, resolveDataDir, setDataDirForTests, WHITEBOARD_ROOT }

// The compiled web-asset directory is a server-only concept (static-file
// middleware). It must not live in the shared layer, which daemon and CLI
// files also import.
//
// The apps/web production build, copied here by its build script. Server mode
// serves it from its own origin (ADR-0047), marked as a server keeper, and
// falls back to a placeholder page only when the directory holds no build
// (server-mode-web-app.ts). The local daemon serves no UI at all (ADR-0050).
export const DIST_WEB_APP_DIR = resolve(WHITEBOARD_ROOT, 'dist/web-app')
