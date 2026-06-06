// Re-export the create+secure data-dir resolution from the shared layer so
// all existing server/store importers keep their '../server/config.js' import
// paths unchanged. The definitions live in the shared layer so daemon files
// can depend on them without importing upward into the server layer.
export { DATA_DIR, resolveDataDir, WHITEBOARD_ROOT, DIST_APP_DIR } from '../shared/data-dir-secure.js'
