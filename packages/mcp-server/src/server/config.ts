import { resolve } from 'node:path'
import {
  DATA_DIR,
  resolveDataDir,
  WHITEBOARD_ROOT,
} from '../shared/data-dir-secure.js'

// Re-export the create+secure data-dir resolution from the shared layer so
// all existing server/store importers keep their '../server/config.js' import
// paths unchanged. The definitions live in the shared layer so daemon files
// can depend on them without importing upward into the server layer.
export { DATA_DIR, resolveDataDir, WHITEBOARD_ROOT }

// The compiled web-asset directory is a server-only concept (static-file
// middleware). It must not live in the shared layer, which daemon and CLI
// files also import.
export const DIST_APP_DIR = resolve(WHITEBOARD_ROOT, 'dist/app')
