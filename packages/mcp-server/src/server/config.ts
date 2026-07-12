import { resolve } from 'node:path'
import { DATA_DIR, resolveDataDir, WHITEBOARD_ROOT } from '../shared/data-dir-secure.js'

// Re-export the create+secure data-dir resolution from the shared layer so
// all existing server/store importers keep their '../server/config.js' import
// paths unchanged. The definitions live in the shared layer so daemon files
// can depend on them without importing upward into the server layer.
export { DATA_DIR, resolveDataDir, WHITEBOARD_ROOT }

// The compiled web-asset directory is a server-only concept (static-file
// middleware). It must not live in the shared layer, which daemon and CLI
// files also import.
//
// The apps/web production build, copied here by its postbuild script.
// Served as the canonical UI in local-daemon mode (ADR 0001, R3). Server-mode
// serves a minimal inline placeholder instead (see app.ts) — it has no
// token/session-acquisition flow apps/web's provider model can use.
export const DIST_WEB_APP_DIR = resolve(WHITEBOARD_ROOT, 'dist/web-app')
