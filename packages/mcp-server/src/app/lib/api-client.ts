// Relocated to src/shared/api-client.ts so apps/web can resolve it via the
// ./daemon-backend package subpath export. Re-exported here so existing
// src/app imports (useBranches.ts, upload-files shim, daemon-backend shim)
// keep working unchanged.

export type { RuntimeConfig } from '../../shared/api-client.js'
export { apiFetch } from '../../shared/api-client.js'
