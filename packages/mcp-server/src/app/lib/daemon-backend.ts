// Relocated to src/shared/daemon-backend.ts so apps/web can resolve it via
// the ./daemon-backend package subpath export. Re-exported here so existing
// src/app imports (useWhiteboardSync.ts) keep working unchanged.
export { DaemonBackend } from '../../shared/daemon-backend.js'
